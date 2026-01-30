// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Script.sol";
import "../src/Vault.sol";

contract DebugRelease is Script {
    function run() external {
        address vaultCaller = 0x431e995B85bbBE03A371B9A58627139BEF4C890b;
        address mirror = 0x87AAB36eF207496bCCBfdaF5855f09985cea7344;
        address user = 0x6Ddc69686bD8F1b5F343355A46B3011F245ED7bE;
        address token = 0x2C960bd5347C2Eb4d9bBEA0CB9671C5b641Dcbb9;
        uint256 amount = 100;

        vm.startBroadcast();
        vm.stopBroadcast();
    }
}