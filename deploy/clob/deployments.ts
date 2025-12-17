import fs from 'node:fs';

export interface Deployment {
    network: string;
    l1: {
        router: `0x${string}`;
        mirror: `0x${string}`; // Deprecated? Or generic mirror?
        vault: `0x${string}`; // VaultCaller
        orderbook: `0x${string}`; // OrderbookCaller
    };
    l2: {
        vault: `0x${string}`;
        orderbook: `0x${string}`;
    };
    timestamp: string;
}

export function saveDeployment(deployment: Deployment, filePath: string = 'deployments.json') {
    const writeFlag = process.env.WRITE_DEPLOYMENTS;
    if (writeFlag && writeFlag.toLowerCase() === 'false') {
        return;
    }
    fs.writeFileSync(filePath, JSON.stringify(deployment, null, 2));
}

export function loadDeployment(filePath: string = 'deployments.json'): Deployment | null {
    if (!fs.existsSync(filePath)) {
        return null;
    }
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content) as Deployment;
}
