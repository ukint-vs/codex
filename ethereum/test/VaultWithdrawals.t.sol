// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../src/Vault.sol";
import "../src/SailsCodec.sol";

// Reusing mocks from Vault.t.sol logic, but defining minimal versions here if needed or importing.
// For simplicity, I'll redefine minimal mocks to keep this file self-contained or use the same ones if I exported them.
// Vault.t.sol has them inline. I'll copy them.

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
    function vaultVaultWithdraw(bool _callReply, uint8[20] calldata, uint8[20] calldata, uint128) external payable returns (bytes32) {
        lastCallReply = _callReply;
        lastPayload = msg.data;
        return bytes32(0);
    }

    function vaultForceExit(bool _callReply, uint8[20] calldata, uint8[20] calldata, uint128) external payable returns (bytes32) {
        lastCallReply = _callReply;
        lastPayload = msg.data;
        return bytes32(0);
    }
    
    function sendMessage(bytes calldata payload, bool _callReply) external payable returns (bytes32) {
        lastPayload = payload;
        lastCallReply = _callReply;
        return bytes32(uint256(1));
    }
}

contract VaultWithdrawalsTest is Test {
    VaultCaller public vault;
    MockProgram public mockProgram;
    MockERC20 public token;
    address public user = address(0x1234);

    function _encodeEthDeposit(address userAddr, address tokenAddr, uint256 amount)
        internal
        pure
        returns (bytes memory)
    {
        bytes memory inner = abi.encode(userAddr, tokenAddr, amount);
        return SailsCodec.encode("Vault", "EthDeposit", inner);
    }

    function _encodeEthWithdraw(address userAddr, address tokenAddr, uint256 amount)
        internal
        pure
        returns (bytes memory)
    {
        bytes memory inner = abi.encode(userAddr, tokenAddr, amount);
        return SailsCodec.encode("Vault", "EthWithdraw", inner);
    }

    function setUp() public {
        mockProgram = new MockProgram();
        vault = new VaultCaller(IVault(address(mockProgram)));
        token = new MockERC20();
        
        // Give the vault some tokens to withdraw
        token.mint(address(vault), 1000);
    }

    function test_ReleaseFunds() public {
        uint256 amount = 100;
        
        // Ensure user starts with 0
        assertEq(token.balances(user), 0);
        
        // Prank as the authorized program
        vm.prank(address(mockProgram));
        vm.expectEmit(true, true, false, true);
        emit VaultCaller.FundsReleased(user, address(token), amount);
        vault.releaseFunds(user, address(token), amount);

        // Assert balance increased (Should fail currently)
        assertEq(token.balances(user), amount);
        // Assert vault balance decreased
        assertEq(token.balances(address(vault)), 900);
    }
    
    function test_ReleaseFunds_Unauthorized() public {
        uint256 amount = 100;
        vm.expectRevert(VaultCaller.UnauthorizedCaller.selector);
        vault.releaseFunds(user, address(token), amount);
    }

    function test_DailyLimit() public {
        uint256 limit = 500;
        vault.setTokenLimit(address(token), limit);

        uint256 amount1 = 300;
        vm.prank(address(mockProgram));
        vault.releaseFunds(user, address(token), amount1);
        assertEq(token.balances(user), amount1);

        uint256 amount2 = 201;
        vm.prank(address(mockProgram));
        vm.expectRevert(VaultCaller.DailyLimitExceeded.selector);
        vault.releaseFunds(user, address(token), amount2);
        
        // Time travel
        vm.warp(block.timestamp + 1 days + 1 seconds);
        
        vm.prank(address(mockProgram));
        vault.releaseFunds(user, address(token), amount2);
        assertEq(token.balances(user), amount1 + amount2);
    }

    function test_EmergencyPause() public {
        vault.togglePause(true);
        assertEq(vault.emergencyPaused(), true);

        uint256 amount = 100;
        vm.prank(address(mockProgram));
        vm.expectRevert(VaultCaller.ContractPaused.selector);
        vault.releaseFunds(user, address(token), amount);

        vault.togglePause(false);
        vm.prank(address(mockProgram));
        vault.releaseFunds(user, address(token), amount);
        assertEq(token.balances(user), amount);
    }

    function test_InitiateWithdrawal() public {
        uint256 amount = 50;
        vm.expectEmit(true, true, false, true);
        emit VaultCaller.WithdrawalRequested(bytes32(uint256(1)), user, address(token), amount);
        vm.prank(user);
        vault.initiateWithdrawal(address(token), amount);

        // Verify payload matches EthWithdraw encoding
        bytes memory expected = _encodeEthWithdraw(user, address(token), amount);
        assertEq(mockProgram.lastPayload(), expected);
        assertEq(mockProgram.lastCallReply(), false);
    }

    /**
     * @dev This test completes the "Full Circuit" verification.
     * It uses the exact byte layout that the Gear program was verified to emit in its gtest.
     */
    function test_FullCircuitSettlement() public {
        uint256 amount = 50;
        
        // Construct the payload as Gear would (Manual ABI encoding)
        // 4 bytes selector + 3*32 bytes padded args
        bytes memory selector = hex"8bbdf2af";
        bytes memory userPadded = abi.encode(user);
        bytes memory tokenPadded = abi.encode(address(token));
        bytes memory amountPadded = abi.encode(amount);
        
        bytes memory gearPayload = abi.encodePacked(selector, userPadded, tokenPadded, amountPadded);
        
        // Verification of the decoder on Ethereum side via low-level call
        vm.prank(address(mockProgram));
        (bool success, ) = address(vault).call(gearPayload);
        
        assertTrue(success, "Low-level call with Gear payload failed");
        assertEq(token.balances(user), amount);
    }

    function test_WithdrawFlow_EndToEnd() public {
        uint256 amount = 75;

        // User initiates withdrawal -> sends message to Gear
        vm.prank(user);
        vault.initiateWithdrawal(address(token), amount);
        bytes memory expected = _encodeEthWithdraw(user, address(token), amount);
        assertEq(mockProgram.lastPayload(), expected);
        assertEq(mockProgram.lastCallReply(), false);

        // Simulate Gear -> L1 release
        vm.prank(address(mockProgram));
        vm.expectEmit(true, true, false, true);
        emit VaultCaller.FundsReleased(user, address(token), amount);
        vault.releaseFunds(user, address(token), amount);
        assertEq(token.balances(user), amount);
    }
}
