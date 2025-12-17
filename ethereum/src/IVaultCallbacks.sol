// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

interface IVaultCallbacks {
    function replyOn_create(bytes32 messageId) external payable;

    function replyOn_vaultAddMarket(bytes32 messageId) external payable;

    function replyOn_vaultClaimFees(bytes32 messageId) external payable;

    function replyOn_vaultUpdateFeeRate(bytes32 messageId) external payable;

    function replyOn_vaultVaultDeposit(bytes32 messageId) external payable;

    function replyOn_vaultVaultReserveFunds(bytes32 messageId) external payable;

    function replyOn_vaultVaultSettleTrade(bytes32 messageId) external payable;

    function replyOn_vaultVaultUnlockFunds(bytes32 messageId) external payable;

    function replyOn_vaultVaultWithdraw(bytes32 messageId) external payable;

    function cancelForceExit(address user, address token, uint256 amount) external;

    function onErrorReply(bytes32 messageId, bytes calldata payload, bytes4 replyCode) external payable;
}
