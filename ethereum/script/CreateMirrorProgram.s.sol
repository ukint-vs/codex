// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";

interface IRouter {
    function createProgram(bytes32 codeId, bytes32 salt, address overrideInitializer) external returns (address);
    function createProgramWithAbiInterface(
        bytes32 codeId,
        bytes32 salt,
        address overrideInitializer,
        address abiInterface
    ) external returns (address);
}


contract CreateMirrorProgram is Script {
    function run() external {
        bytes32 pkBytes = vm.envBytes32("PRIVATE_KEY");
        uint256 deployerPrivateKey = uint256(pkBytes);

        address routerAddress = vm.envAddress("ROUTER_ADDRESS");
        bytes32 codeId = vm.envBytes32("CODE_ID");
        address abiInterface = vm.envOr("ABI_INTERFACE", address(0));

        console.log("Router Address:", routerAddress);
        console.log("Code ID:", vm.toString(codeId));
        console.log("ABI Interface:", abiInterface);

        vm.startBroadcast(deployerPrivateKey);
        IRouter router = IRouter(routerAddress);

        bytes32 salt = bytes32(vm.randomBytes(32));
        address program = address(0);

        if (abiInterface != address(0)) {
            program = router.createProgramWithAbiInterface(codeId, salt, address(0), abiInterface);
        } else {
            program = router.createProgram(codeId, salt, address(0));
        }

        console.log("Program created:", program);

        vm.stopBroadcast();
    }
}
