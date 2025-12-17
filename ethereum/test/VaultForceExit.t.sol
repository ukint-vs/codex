// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../src/Vault.sol";

// Mock Program that implements the updated IVault
contract MockProgram is IVault {
    bytes public lastPayload;
    bool public lastCallReply;

    function create(bool) external payable returns (bytes32) { return bytes32(0); }
    function vaultAddMarket(bool, bytes32) external payable returns (bytes32) { return bytes32(0); }
    function vaultClaimFees(bool, uint8[20] calldata) external payable returns (bytes32) { return bytes32(0); }
    function vaultUpdateFeeRate(bool, uint128) external payable returns (bytes32) { return bytes32(0); }
    function vaultVaultDeposit(bool, uint8[20] calldata, uint8[20] calldata, uint128) external payable returns (bytes32) { return bytes32(0); }
    function vaultVaultReserveFunds(bool, uint8[20] calldata, uint8[20] calldata, uint128) external payable returns (bytes32) { return bytes32(0); }
    function vaultVaultSettleTrade(bool, uint8[20] calldata, uint8[20] calldata, uint8[20] calldata, uint8[20] calldata, uint128, uint128, uint128) external payable returns (bytes32) { return bytes32(0); }
    function vaultVaultUnlockFunds(bool, uint8[20] calldata, uint8[20] calldata, uint128) external payable returns (bytes32) { return bytes32(0); }
    function vaultVaultWithdraw(bool, uint8[20] calldata, uint8[20] calldata, uint128) external payable returns (bytes32) { return bytes32(0); }
    
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

contract MockERC20 is IERC20 {
    mapping(address => uint256) public balances;
    function transfer(address to, uint256 amount) external returns (bool) {
        balances[to] += amount;
        return true;
    }
    // minimal implementation
    function totalSupply() external view returns (uint256) { return 0; }
    function balanceOf(address account) external view returns (uint256) { return balances[account]; }
    function allowance(address, address) external view returns (uint256) { return 0; }
    function approve(address, uint256) external returns (bool) { return true; }
    function transferFrom(address, address, uint256) external returns (bool) { return true; }
    function mint(address to, uint256 amount) public { balances[to] += amount; }
}

contract VaultForceExitTest is Test {
    VaultCaller public vault;
    MockProgram public mockProgram;
    MockERC20 public token;
    address public user = address(0x1111);

    event ForceExitInitiated(address indexed user, address indexed token, uint256 amount);
    event ForceExitClaimed(address indexed user, address indexed token, uint256 amount);

    function setUp() public {
        mockProgram = new MockProgram();
        vault = new VaultCaller(IVault(address(mockProgram)));
        token = new MockERC20();
        token.mint(address(vault), 1000); // Vault has funds
    }

    function test_InitiateForceExit_StoresRequest_And_CallsBridge() public {
        uint256 amount = 100;
        
        vm.prank(user);
        vm.expectEmit(true, true, false, true);
        emit ForceExitInitiated(user, address(token), amount);
        
        vault.initiateForceExit(address(token), amount);

        (uint256 reqAmount, uint256 reqTimestamp) = vault.forceExits(user, address(token));
        assertEq(reqAmount, amount, "Amount mismatch");
        assertEq(reqTimestamp, block.timestamp, "Timestamp mismatch");

        // Check bridge call
        assertTrue(mockProgram.lastPayload().length > 0, "Should call bridge");
    }

    function test_ClaimForceExit_FailsBeforeDelay() public {
        uint256 amount = 100;
        vm.prank(user);
        vault.initiateForceExit(address(token), amount);

        vm.warp(block.timestamp + 6 days); // Less than 7 days

        vm.prank(user);
        vm.expectRevert("Challenge period not over"); // I expect this revert string
        vault.claimForceExit(address(token));
    }

    function test_ClaimForceExit_FailsIfNoRequest() public {
        vm.prank(user);
        vm.expectRevert("No pending force exit");
        vault.claimForceExit(address(token));
    }

    function test_ClaimForceExit_SuccessAfterDelay() public {
        uint256 amount = 100;
        vm.prank(user);
        vault.initiateForceExit(address(token), amount);

        vm.warp(block.timestamp + 7 days + 1 seconds);

        vm.prank(user);
        vm.expectEmit(true, true, false, true);
        emit ForceExitClaimed(user, address(token), amount);
        
        vault.claimForceExit(address(token));

        assertEq(token.balances(user), amount, "User received funds");
        
        (uint256 reqAmount, ) = vault.forceExits(user, address(token));
        assertEq(reqAmount, 0, "Request should be cleared");
    }

    function test_CancelForceExit_ByBridge() public {
        uint256 amount = 100;
        vm.prank(user);
        vault.initiateForceExit(address(token), amount);

        // Verification call from bridge
        vm.prank(address(mockProgram));
        vault.cancelForceExit(user, address(token), amount);

        (uint256 reqAmount, ) = vault.forceExits(user, address(token));
        assertEq(reqAmount, 0, "Request should be cleared after cancellation");
        assertEq(token.balances(user), amount, "User should receive funds");

        // Attempting to claim should now fail
        vm.warp(block.timestamp + 8 days);
        vm.prank(user);
        vm.expectRevert("No pending force exit");
        vault.claimForceExit(address(token));
    }

    function test_CancelForceExit_Unauthorized() public {
        vm.expectRevert(VaultCaller.UnauthorizedCaller.selector);
        vault.cancelForceExit(user, address(token), 100);
    }
}
