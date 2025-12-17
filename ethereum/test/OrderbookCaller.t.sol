// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../src/Orderbook.sol";
import "../src/SailsCodec.sol";

contract MockVaraProgram is IOrderbook {
    bool public lastCallReply;
    bytes public lastPayload;
    uint8[20] public lastUser;
    uint128 public lastPrice;
    uint128 public lastQuantity;
    bool public lastIsBuy;
    uint8[20] public lastBaseToken;
    uint8[20] public lastQuoteToken;
    uint128 public lastOrderId;
    uint8[20] public lastContinueBaseToken;
    uint8[20] public lastContinueQuoteToken;

    function getLastUser() external view returns (uint8[20] memory) {
        return lastUser;
    }

    function getLastBaseToken() external view returns (uint8[20] memory) {
        return lastBaseToken;
    }

    function getLastQuoteToken() external view returns (uint8[20] memory) {
        return lastQuoteToken;
    }

    function create(bool _callReply, bytes32 vaultId) external payable returns (bytes32 messageId) {}

    function orderBookCancelOrder(
        bool callReply,
        uint8[20] calldata user,
        uint128 orderId,
        uint8[20] calldata baseToken,
        uint8[20] calldata quoteToken
    ) external payable returns (bytes32 messageId) {
        lastCallReply = callReply;
        lastUser = user;
        lastOrderId = orderId;
        lastBaseToken = baseToken;
        lastQuoteToken = quoteToken;
        return bytes32(uint256(1));
    }

    function orderBookContinueMatching(
        bool callReply,
        uint8[20] calldata baseToken,
        uint8[20] calldata quoteToken
    ) external payable returns (bytes32 messageId) {
        lastCallReply = callReply;
        lastContinueBaseToken = baseToken;
        lastContinueQuoteToken = quoteToken;
        return bytes32(uint256(1));
    }

    function orderBookPlaceOrder(
        bool callReply,
        uint8[20] calldata user,
        uint128 price,
        uint128 quantity,
        bool isBuy,
        uint8[20] calldata baseToken,
        uint8[20] calldata quoteToken
    ) external payable returns (bytes32 messageId) {
        lastCallReply = callReply;
        lastUser = user;
        lastPrice = price;
        lastQuantity = quantity;
        lastIsBuy = isBuy;
        lastBaseToken = baseToken;
        lastQuoteToken = quoteToken;
        return bytes32(uint256(1));
    }

    function sendMessage(bytes calldata payload, bool callReply) external payable returns (bytes32 messageId) {
        lastCallReply = callReply;
        lastPayload = payload;
        return bytes32(uint256(1));
    }
}

contract OrderbookCallerTest is Test {
    OrderbookCaller public caller;
    MockVaraProgram public mockProgram;
    address public user = address(0x1234);
    address public baseToken = address(0xAAAA);
    address public quoteToken = address(0xBBBB);

    event OrderPlaced(uint256 indexed nonce, address indexed user, uint128 price, uint128 quantity, bool isBuy, address baseToken, address quoteToken);
    event OrderCanceled(uint256 indexed nonce, address indexed user, uint128 orderId);

    function setUp() public {
        mockProgram = new MockVaraProgram();
        caller = new OrderbookCaller(IOrderbook(address(mockProgram)));
    }

    function test_PlaceOrder_IncrementsNonce_And_EmitsEvent() public {
        uint128 price = 100;
        uint128 quantity = 50;
        bool isBuy = true;

        uint256 initialNonce = caller.nonces(user);
        
        vm.prank(user);
        vm.expectEmit(true, true, false, true);
        emit OrderPlaced(initialNonce + 1, user, price, quantity, isBuy, baseToken, quoteToken);
        
        caller.placeOrder(price, quantity, isBuy, baseToken, quoteToken);

        uint256 newNonce = caller.nonces(user);
        assertEq(newNonce, initialNonce + 1, "Nonce should increment");

        assertFalse(mockProgram.lastCallReply(), "Should not request reply");
        bytes memory expected = _encodeOrderBookPlaceOrderEth(
            user,
            price,
            quantity,
            isBuy,
            baseToken,
            quoteToken
        );
        assertEq(keccak256(mockProgram.lastPayload()), keccak256(expected), "Unexpected payload");
    }

    function test_CancelOrder_IncrementsNonce_And_EmitsEvent() public {
        uint128 orderId = 999;

        uint256 initialNonce = caller.nonces(user);
        
        vm.prank(user);
        vm.expectEmit(true, true, false, true);
        emit OrderCanceled(initialNonce + 1, user, orderId);
        
        caller.cancelOrder(orderId, baseToken, quoteToken);

        uint256 newNonce = caller.nonces(user);
        assertEq(newNonce, initialNonce + 1, "Nonce should increment");
        assertFalse(mockProgram.lastCallReply(), "Should not request reply");
        bytes memory expected = _encodeOrderBookCancelOrderEth(
            user,
            orderId,
            baseToken,
            quoteToken
        );
        assertEq(keccak256(mockProgram.lastPayload()), keccak256(expected), "Unexpected payload");
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
}
