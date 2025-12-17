// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../src/Vault.sol";

contract MockERC20 is IERC20 {
    mapping(address => mapping(address => uint256)) public allowances;
    mapping(address => uint256) public balances;

    function totalSupply() external view returns (uint256) { return 0; }
    function balanceOf(address account) external view returns (uint256) { return balances[account]; }
    function allowance(address owner, address spender) external view returns (uint256) { return allowances[owner][spender]; }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (balances[msg.sender] < amount) return false;
        balances[msg.sender] -= amount;
        balances[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (balances[from] < amount) return false;
        if (allowances[from][msg.sender] < amount) return false;
        balances[from] -= amount;
        balances[to] += amount;
        return true;
    }

    function mint(address to, uint256 amount) public {
        balances[to] += amount;
    }

    function approve(address spender, uint256 amount) public returns (bool) {
        allowances[msg.sender][spender] = amount;
        return true;
    }
}

contract MockProgram is IVault {
    bytes public lastPayload;
    bool public lastCallReply;

    function create(bool) external payable returns (bytes32) { return bytes32(0); }
    function vaultAddMarket(bool, bytes32) external payable returns (bytes32) { return bytes32(0); }
    function vaultClaimFees(bool, uint8[20] calldata) external payable returns (bytes32) { return bytes32(0); }
    function vaultUpdateFeeRate(bool, uint128) external payable returns (bytes32) { return bytes32(0); }
    function vaultVaultDeposit(bool _callReply, uint8[20] calldata, uint8[20] calldata, uint128) external payable returns (bytes32) {
        lastCallReply = _callReply;
        lastPayload = msg.data;
        return bytes32(0);
    }
    function vaultVaultReserveFunds(bool, uint8[20] calldata, uint8[20] calldata, uint128) external payable returns (bytes32) { return bytes32(0); }
    function vaultVaultSettleTrade(bool, uint8[20] calldata, uint8[20] calldata, uint8[20] calldata, uint8[20] calldata, uint128, uint128, uint128) external payable returns (bytes32) { return bytes32(0); }
    function vaultVaultUnlockFunds(bool, uint8[20] calldata, uint8[20] calldata, uint128) external payable returns (bytes32) { return bytes32(0); }
    function vaultVaultWithdraw(bool, uint8[20] calldata, uint8[20] calldata, uint128) external payable returns (bytes32) { return bytes32(0); }
    function vaultForceExit(bool, uint8[20] calldata, uint8[20] calldata, uint128) external payable returns (bytes32) { return bytes32(0); }

    function sendMessage(bytes calldata payload, bool _callReply) external payable returns (bytes32) {
        lastPayload = payload;
        lastCallReply = _callReply;
        return bytes32(uint256(1));
    }
}

contract VaultTest is Test {
    VaultCaller public vault;
    MockProgram public mockProgram;
    MockERC20 public token;
    address public user = address(0xABCD);

    function _compactLen(uint256 len) internal pure returns (bytes memory) {
        if (len < 1 << 6) {
            return abi.encodePacked(uint8(len << 2));
        }
        if (len < 1 << 14) {
            uint16 v = uint16((len << 2) | 0x01);
            return abi.encodePacked(uint8(v), uint8(v >> 8));
        }
        if (len < 1 << 30) {
            uint32 v = uint32((len << 2) | 0x02);
            return abi.encodePacked(
                uint8(v),
                uint8(v >> 8),
                uint8(v >> 16),
                uint8(v >> 24)
            );
        }
        revert("Length too large");
    }

    function setUp() public {
        mockProgram = new MockProgram();
        vault = new VaultCaller(IVault(address(mockProgram)));
        token = new MockERC20();
        token.mint(user, 1000);
    }

    function test_Deposit() public {
        uint256 amount = 500;
        vm.prank(user);
        token.approve(address(vault), amount);

        vm.prank(user);
        vault.deposit(address(token), amount);

        assertEq(token.balances(address(vault)), amount);
        assertEq(token.balances(user), 500);

        bytes memory inner = abi.encode(user, address(token), amount);
        bytes memory expected = abi.encodePacked(
            _compactLen(bytes("Vault").length),
            "Vault",
            _compactLen(bytes("EthDeposit").length),
            "EthDeposit",
            _compactLen(inner.length),
            inner
        );

        assertEq(mockProgram.lastPayload(), expected);
        assertEq(mockProgram.lastCallReply(), false);
    }

    function test_Deposit_FailsWithoutApproval() public {
        uint256 amount = 500;
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(token)));
        vault.deposit(address(token), amount);
    }
}
