// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {SailsCodec} from "./SailsCodec.sol";

interface IOrderbook {
    event OrderPlaced(uint128 orderId, uint128 price, uint128 quantity, uint32 isBuy);

    event OrderCanceled(uint128 orderId);

    event TradeExecuted(uint128 makerOrderId, uint128 takerOrderId, uint128 price, uint128 quantity, uint8[32] maker, uint8[32] taker);

    function create(bool _callReply, bytes32 vaultId) external payable returns (bytes32 messageId);

    function orderBookCancelOrder(bool _callReply, uint8[20] calldata user, uint128 orderId, uint8[20] calldata baseToken, uint8[20] calldata quoteToken) external payable returns (bytes32 messageId);

    function orderBookContinueMatching(bool _callReply, uint8[20] calldata baseToken, uint8[20] calldata quoteToken) external payable returns (bytes32 messageId);

    function orderBookPlaceOrder(bool _callReply, uint8[20] calldata user, uint128 price, uint128 quantity, bool isBuy, uint8[20] calldata baseToken, uint8[20] calldata quoteToken) external payable returns (bytes32 messageId);

    function sendMessage(bytes calldata payload, bool _callReply) external payable returns (bytes32 messageId);
}

contract OrderbookAbi is IOrderbook {
    function create(bool _callReply, bytes32 vaultId) external payable returns (bytes32 messageId) {}

    function orderBookCancelOrder(bool _callReply, uint8[20] calldata user, uint128 orderId, uint8[20] calldata baseToken, uint8[20] calldata quoteToken) external payable returns (bytes32 messageId) {}

    function orderBookContinueMatching(bool _callReply, uint8[20] calldata baseToken, uint8[20] calldata quoteToken) external payable returns (bytes32 messageId) {}

    function orderBookPlaceOrder(bool _callReply, uint8[20] calldata user, uint128 price, uint128 quantity, bool isBuy, uint8[20] calldata baseToken, uint8[20] calldata quoteToken) external payable returns (bytes32 messageId) {}

    function sendMessage(bytes calldata payload, bool _callReply) external payable returns (bytes32 messageId) {}
}

interface IOrderbookCallbacks {
    function replyOn_create(bytes32 messageId) external payable;

    function replyOn_orderBookCancelOrder(bytes32 messageId) external payable;

    function replyOn_orderBookContinueMatching(bytes32 messageId) external payable;

    function replyOn_orderBookPlaceOrder(bytes32 messageId) external payable;

    function onErrorReply(bytes32 messageId, bytes calldata payload, bytes4 replyCode) external payable;
}

contract OrderbookCaller is IOrderbookCallbacks {
    IOrderbook public immutable VAR_ETH_PROGRAM;

    error UnauthorizedCaller();

    event OrderPlaced(uint256 indexed nonce, address indexed user, uint128 price, uint128 quantity, bool isBuy, address baseToken, address quoteToken);
    event OrderCanceled(uint256 indexed nonce, address indexed user, uint128 orderId);
    event L2Message(bytes32 indexed messageId, uint8 action, address indexed user);

    uint8 private constant ACTION_PLACE = 1;
    uint8 private constant ACTION_CANCEL = 2;
    uint8 private constant ACTION_CONTINUE = 3;

    mapping(address => uint256) public nonces;

    constructor(IOrderbook _varaEthProgram) {
        VAR_ETH_PROGRAM = _varaEthProgram;
    }

    modifier onlyVaraEthProgram() {
        _onlyVaraEthProgram();
        _;
    }

    function _onlyVaraEthProgram() internal {
        if (msg.sender != address(VAR_ETH_PROGRAM)) {
            revert UnauthorizedCaller();
        }
    }

    function placeOrder(uint128 price, uint128 quantity, bool isBuy, address baseToken, address quoteToken) external {
        nonces[msg.sender]++;
        emit OrderPlaced(nonces[msg.sender], msg.sender, price, quantity, isBuy, baseToken, quoteToken);

        bytes memory payload = _encodeOrderBookPlaceOrderEth(
            msg.sender,
            price,
            quantity,
            isBuy,
            baseToken,
            quoteToken
        );
        bytes32 messageId = VAR_ETH_PROGRAM.sendMessage(payload, false);
        emit L2Message(messageId, ACTION_PLACE, msg.sender);
    }

    function cancelOrder(uint128 orderId, address baseToken, address quoteToken) external {
        nonces[msg.sender]++;
        emit OrderCanceled(nonces[msg.sender], msg.sender, orderId);

        bytes memory payload = _encodeOrderBookCancelOrderEth(
            msg.sender,
            orderId,
            baseToken,
            quoteToken
        );
        bytes32 messageId = VAR_ETH_PROGRAM.sendMessage(payload, false);
        emit L2Message(messageId, ACTION_CANCEL, msg.sender);
    }

    function continueMatching(address baseToken, address quoteToken) external {
        bytes memory payload = _encodeOrderBookContinueMatching(
            baseToken,
            quoteToken
        );
        bytes32 messageId = VAR_ETH_PROGRAM.sendMessage(payload, false);
        emit L2Message(messageId, ACTION_CONTINUE, address(0));
    }

    function _encodeOrderBookPlaceOrderEth(
        address user,
        uint128 price,
        uint128 quantity,
        bool isBuy,
        address baseToken,
        address quoteToken
    ) internal pure returns (bytes memory) {
        bytes memory inner = abi.encodePacked(
            bytes20(uint160(user)),
            _encodeU128LE(price),
            _encodeU128LE(quantity),
            _encodeBool(isBuy),
            bytes20(uint160(baseToken)),
            bytes20(uint160(quoteToken))
        );
        return SailsCodec.encode("OrderBook", "PlaceOrderEth", inner);
    }

    function _encodeOrderBookCancelOrderEth(
        address user,
        uint128 orderId,
        address baseToken,
        address quoteToken
    ) internal pure returns (bytes memory) {
        bytes memory inner = abi.encodePacked(
            bytes20(uint160(user)),
            _encodeU128LE(orderId),
            bytes20(uint160(baseToken)),
            bytes20(uint160(quoteToken))
        );
        return SailsCodec.encode("OrderBook", "CancelOrderEth", inner);
    }

    function _encodeOrderBookContinueMatching(
        address baseToken,
        address quoteToken
    ) internal pure returns (bytes memory) {
        bytes memory inner = abi.encodePacked(
            bytes20(uint160(baseToken)),
            bytes20(uint160(quoteToken))
        );
        return SailsCodec.encode("OrderBook", "ContinueMatching", inner);
    }

    function _encodeU128LE(uint128 value) internal pure returns (bytes memory out) {
        out = new bytes(16);
        for (uint256 i = 0; i < 16; i++) {
            out[i] = bytes1(uint8(value));
            value >>= 8;
        }
    }

    function _encodeBool(bool value) internal pure returns (bytes1) {
        return value ? bytes1(0x01) : bytes1(0x00);
    }

    function replyOn_create(bytes32 messageId) external payable onlyVaraEthProgram {
        // no-op placeholder
    }

    function replyOn_orderBookCancelOrder(bytes32 messageId) external payable onlyVaraEthProgram {
        // no-op placeholder
    }

    function replyOn_orderBookContinueMatching(bytes32 messageId) external payable onlyVaraEthProgram {
        // no-op placeholder
    }

    function replyOn_orderBookPlaceOrder(bytes32 messageId) external payable onlyVaraEthProgram {
        // no-op placeholder
    }

    function onErrorReply(bytes32 messageId, bytes calldata payload, bytes4 replyCode) external payable onlyVaraEthProgram {
        // no-op placeholder
    }
}
