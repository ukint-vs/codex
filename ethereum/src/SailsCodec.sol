// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

library SailsCodec {
    function scaleCompactLen(uint256 len) internal pure returns (bytes memory) {
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

    function encode(
        string memory service,
        string memory method,
        bytes memory inner
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(
            scaleCompactLen(bytes(service).length),
            service,
            scaleCompactLen(bytes(method).length),
            method,
            scaleCompactLen(inner.length),
            inner
        );
    }
}
