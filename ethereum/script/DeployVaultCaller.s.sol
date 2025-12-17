// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {VaultCaller, IVault} from "../src/Vault.sol";

contract DeployVaultCaller is Script {
    function run() external returns (address) {
        bytes32 pkBytes = vm.envBytes32("PRIVATE_KEY");
        uint256 deployerPrivateKey = uint256(pkBytes);
        address routerAddress = vm.envAddress("ROUTER_ADDRESS");

        vm.startBroadcast(deployerPrivateKey);
        VaultCaller vault = new VaultCaller(IVault(routerAddress));
        console.log("VaultCaller deployed at:", address(vault));
        vm.stopBroadcast();
        return address(vault);
    }
}
