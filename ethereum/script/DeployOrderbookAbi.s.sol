// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {OrderbookAbi} from "../src/Orderbook.sol";

contract DeployOrderbookAbi is Script {
    function run() external returns (address) {
        bytes32 pkBytes = vm.envBytes32("PRIVATE_KEY");
        uint256 deployerPrivateKey = uint256(pkBytes);

        vm.startBroadcast(deployerPrivateKey);
        OrderbookAbi abiContract = new OrderbookAbi();
        console.log("OrderbookAbi deployed at:", address(abiContract));
        vm.stopBroadcast();
        return address(abiContract);
    }
}
