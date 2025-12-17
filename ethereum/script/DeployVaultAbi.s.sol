// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {VaultAbi} from "../src/Vault.sol";

contract DeployVaultAbi is Script {
    function run() external returns (address) {
        bytes32 pkBytes = vm.envBytes32("PRIVATE_KEY");
        uint256 deployerPrivateKey = uint256(pkBytes);

        vm.startBroadcast(deployerPrivateKey);
        VaultAbi abiContract = new VaultAbi();
        console.log("VaultAbi deployed at:", address(abiContract));
        vm.stopBroadcast();
        return address(abiContract);
    }
}
