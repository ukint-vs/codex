// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IVault} from "./IVault.sol";
import {IVaultCallbacks} from "./IVaultCallbacks.sol";
import {SailsCodec} from "./SailsCodec.sol";

contract VaultAbi is IVault {
    function create(bool _callReply) external payable returns (bytes32 messageId) {}

    function vaultAddMarket(bool _callReply, bytes32 programId) external payable returns (bytes32 messageId) {}

    function vaultClaimFees(bool _callReply, uint8[20] calldata token) external payable returns (bytes32 messageId) {}

    function vaultUpdateFeeRate(bool _callReply, uint128 newRate) external payable returns (bytes32 messageId) {}

    function vaultVaultDeposit(bool _callReply, uint8[20] calldata user, uint8[20] calldata token, uint128 amount) external payable returns (bytes32 messageId) {}

    function vaultVaultReserveFunds(bool _callReply, uint8[20] calldata user, uint8[20] calldata token, uint128 amount) external payable returns (bytes32 messageId) {}

    function vaultVaultSettleTrade(bool _callReply, uint8[20] calldata buyer, uint8[20] calldata seller, uint8[20] calldata baseToken, uint8[20] calldata quoteToken, uint128 price, uint128 quantity, uint128 fee) external payable returns (bytes32 messageId) {}

    function vaultVaultUnlockFunds(bool _callReply, uint8[20] calldata user, uint8[20] calldata token, uint128 amount) external payable returns (bytes32 messageId) {}

    function vaultVaultWithdraw(bool _callReply, uint8[20] calldata user, uint8[20] calldata token, uint128 amount) external payable returns (bytes32 messageId) {}

    function vaultForceExit(bool _callReply, uint8[20] calldata user, uint8[20] calldata token, uint128 amount) external payable returns (bytes32 messageId) {}

    function sendMessage(bytes calldata payload, bool _callReply) external payable returns (bytes32 messageId) {}
}

contract VaultCaller is IVaultCallbacks {
    using SafeERC20 for IERC20;

    IVault public immutable VAR_ETH_PROGRAM;
    address public owner;

    struct TokenLimit {
        uint256 dailyCap;
        uint256 currentWithdrawn;
        uint256 lastResetTimestamp;
    }

    struct ForceExitRequest {
        uint256 amount;
        uint256 timestamp;
    }

    mapping(address => TokenLimit) public tokenLimits;
    mapping(address => mapping(address => ForceExitRequest)) public forceExits;
    mapping(bytes32 => PendingDeposit) public pendingDeposits;
    
    uint256 public constant FORCE_EXIT_DELAY = 7 days;
    bool public emergencyPaused;

    struct PendingDeposit {
        address user;
        address token;
        uint256 amount;
    }

    event ForceExitInitiated(address indexed user, address indexed token, uint256 amount);
    event ForceExitClaimed(address indexed user, address indexed token, uint256 amount);
    event ForceExitCancelled(address indexed user, address indexed token);
    event DepositRequested(bytes32 indexed messageId, address indexed user, address indexed token, uint256 amount);
    event DepositFinalized(bytes32 indexed messageId);
    event DepositFailed(bytes32 indexed messageId, address indexed user, address indexed token, uint256 amount, bytes payload, bytes4 replyCode);
    event WithdrawalRequested(bytes32 indexed messageId, address indexed user, address indexed token, uint256 amount);
    event WithdrawalFailed(bytes32 indexed messageId, bytes payload, bytes4 replyCode);
    event FundsReleased(address indexed user, address indexed token, uint256 amount);

    error UnauthorizedCaller();
    error DailyLimitExceeded();
    error UnauthorizedOwner();
    error ContractPaused();

    constructor(IVault _varaEthProgram) {
        VAR_ETH_PROGRAM = _varaEthProgram;
        owner = msg.sender;
    }

    modifier onlyVaraEthProgram() {
        _onlyVaraEthProgram();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) {
            revert UnauthorizedOwner();
        }
        _;
    }

    function _onlyVaraEthProgram() internal view {
        if (msg.sender != address(VAR_ETH_PROGRAM)) {
            revert UnauthorizedCaller();
        }
    }

    function _toUint8_20(address addr) public pure returns (uint8[20] memory result) {
        bytes20 b = bytes20(addr);
        for (uint256 i = 0; i < 20; i++) {
            result[i] = uint8(b[i]);
        }
    }

    function setTokenLimit(address token, uint256 dailyCap) external onlyOwner {
        tokenLimits[token].dailyCap = dailyCap;
    }

    function togglePause(bool _paused) external onlyOwner {
        emergencyPaused = _paused;
    }

    function deposit(address token, uint256 amount) external {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        bytes memory payload = _encodeEthDeposit(msg.sender, token, amount);
        bytes32 messageId = VAR_ETH_PROGRAM.sendMessage(payload, false);
        emit DepositRequested(messageId, msg.sender, token, amount);
    }

    function initiateWithdrawal(address token, uint256 amount) external {
        bytes memory payload = _encodeEthWithdraw(msg.sender, token, amount);
        bytes32 messageId = VAR_ETH_PROGRAM.sendMessage(payload, false);
        emit WithdrawalRequested(messageId, msg.sender, token, amount);
    }

    function initiateForceExit(address token, uint256 amount) external {
        forceExits[msg.sender][token] = ForceExitRequest({
            amount: amount,
            timestamp: block.timestamp
        });

        emit ForceExitInitiated(msg.sender, token, amount);

        VAR_ETH_PROGRAM.vaultForceExit(
            false,
            _toUint8_20(msg.sender),
            _toUint8_20(token),
            uint128(amount)
        );
    }

    function claimForceExit(address token) external {
        ForceExitRequest storage request = forceExits[msg.sender][token];
        
        if (request.amount == 0) {
            revert("No pending force exit");
        }

        if (block.timestamp < request.timestamp + FORCE_EXIT_DELAY) {
            revert("Challenge period not over");
        }

        uint256 amount = request.amount;
        delete forceExits[msg.sender][token];

        emit ForceExitClaimed(msg.sender, token, amount);

        IERC20(token).safeTransfer(msg.sender, amount);
    }

    function cancelForceExit(address user, address token, uint256 amount) external onlyVaraEthProgram {
        delete forceExits[user][token];
        emit ForceExitCancelled(user, token);
        IERC20(token).safeTransfer(user, amount);
    }

    function releaseFunds(address user, address token, uint256 amount) external onlyVaraEthProgram {
        if (emergencyPaused) {
            revert ContractPaused();
        }

        TokenLimit storage limit = tokenLimits[token];
        
        if (limit.dailyCap > 0) {
            if (block.timestamp >= limit.lastResetTimestamp + 1 days) {
                limit.currentWithdrawn = 0;
                limit.lastResetTimestamp = block.timestamp;
            }
            if (limit.currentWithdrawn + amount > limit.dailyCap) {
                revert DailyLimitExceeded();
            }
            limit.currentWithdrawn += amount;
        }

        IERC20(token).safeTransfer(user, amount);
        emit FundsReleased(user, token, amount);
    }

    function replyOn_create(bytes32 messageId) external payable onlyVaraEthProgram {}

    function replyOn_vaultAddMarket(bytes32 messageId) external payable onlyVaraEthProgram {}

    function replyOn_vaultClaimFees(bytes32 messageId) external payable onlyVaraEthProgram {}

    function replyOn_vaultUpdateFeeRate(bytes32 messageId) external payable onlyVaraEthProgram {}

    function replyOn_vaultVaultDeposit(bytes32 messageId) external payable onlyVaraEthProgram {
        delete pendingDeposits[messageId];
        emit DepositFinalized(messageId);
    }

    function replyOn_vaultVaultReserveFunds(bytes32 messageId) external payable onlyVaraEthProgram {}

    function replyOn_vaultVaultSettleTrade(bytes32 messageId) external payable onlyVaraEthProgram {}

    function replyOn_vaultVaultUnlockFunds(bytes32 messageId) external payable onlyVaraEthProgram {}

    function replyOn_vaultVaultWithdraw(bytes32 messageId) external payable onlyVaraEthProgram {}

    function onErrorReply(bytes32 messageId, bytes calldata payload, bytes4 replyCode) external payable onlyVaraEthProgram {
        PendingDeposit memory pending = pendingDeposits[messageId];
        if (pending.user != address(0) && pending.amount != 0) {
            delete pendingDeposits[messageId];
            IERC20(pending.token).safeTransfer(pending.user, pending.amount);
            emit DepositFailed(messageId, pending.user, pending.token, pending.amount, payload, replyCode);
        } else {
            emit WithdrawalFailed(messageId, payload, replyCode);
        }
    }

    function _encodeEthDeposit(address user, address token, uint256 amount)
        internal
        pure
        returns (bytes memory)
    {
        bytes memory inner = abi.encode(user, token, amount);
        return SailsCodec.encode("Vault", "EthDeposit", inner);
    }

    function _encodeEthWithdraw(address user, address token, uint256 amount)
        internal
        pure
        returns (bytes memory)
    {
        bytes memory inner = abi.encode(user, token, amount);
        return SailsCodec.encode("Vault", "EthWithdraw", inner);
    }
}
