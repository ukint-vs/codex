// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

interface IVault {
    event Deposit(uint8[20] user, uint8[20] token, uint128 amount, uint128 balanceAfter);

    event Withdrawal(uint8[20] user, uint8[20] token, uint128 amount, string status);

    event FundsReserved(uint8[20] user, uint8[20] token, uint128 amount);

    event FundsUnlocked(uint8[20] user, uint8[20] token, uint128 amount);

    event TradeSettled(uint8[20] buyer, uint8[20] seller, uint8[20] baseToken, uint8[20] quoteToken, uint128 price, uint128 quantity, uint128 fee);

    function create(bool _callReply) external payable returns (bytes32 messageId);

    function vaultAddMarket(bool _callReply, bytes32 programId) external payable returns (bytes32 messageId);

    function vaultClaimFees(bool _callReply, uint8[20] calldata token) external payable returns (bytes32 messageId);

    function vaultUpdateFeeRate(bool _callReply, uint128 newRate) external payable returns (bytes32 messageId);

    function vaultVaultDeposit(bool _callReply, uint8[20] calldata user, uint8[20] calldata token, uint128 amount) external payable returns (bytes32 messageId);

    function vaultVaultReserveFunds(bool _callReply, uint8[20] calldata user, uint8[20] calldata token, uint128 amount) external payable returns (bytes32 messageId);

    function vaultVaultSettleTrade(bool _callReply, uint8[20] calldata buyer, uint8[20] calldata seller, uint8[20] calldata baseToken, uint8[20] calldata quoteToken, uint128 price, uint128 quantity, uint128 fee) external payable returns (bytes32 messageId);

    function vaultVaultUnlockFunds(bool _callReply, uint8[20] calldata user, uint8[20] calldata token, uint128 amount) external payable returns (bytes32 messageId);

    function vaultVaultWithdraw(bool _callReply, uint8[20] calldata user, uint8[20] calldata token, uint128 amount) external payable returns (bytes32 messageId);

    function vaultForceExit(bool _callReply, uint8[20] calldata user, uint8[20] calldata token, uint128 amount) external payable returns (bytes32 messageId);

    function sendMessage(bytes calldata payload, bool _callReply) external payable returns (bytes32 messageId);
}
