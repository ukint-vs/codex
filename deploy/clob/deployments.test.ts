import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { saveDeployment, loadDeployment, Deployment } from './deployments';
import fs from 'node:fs';
import path from 'node:path';

const TEST_FILE = 'test-deployments.json';

describe('Deployments Utility', () => {
    beforeEach(() => {
        if (fs.existsSync(TEST_FILE)) {
            fs.unlinkSync(TEST_FILE);
        }
    });

    afterEach(() => {
        if (fs.existsSync(TEST_FILE)) {
            fs.unlinkSync(TEST_FILE);
        }
    });

    it('should save and load a deployment correctly', () => {
        const deployment: Deployment = {
            network: 'hoodi-vara',
            l1: {
                router: '0x1234567890123456789012345678901234567890',
                mirror: '0x2234567890123456789012345678901234567890',
                vault: '0x3234567890123456789012345678901234567890',
                orderbook: '0x6234567890123456789012345678901234567890',
            },
            l2: {
                vault: '0x4234567890123456789012345678901234567890123456789012345678901234',
                orderbook: '0x5234567890123456789012345678901234567890123456789012345678901234',
            },
            timestamp: new Date().toISOString(),
        };

        saveDeployment(deployment, TEST_FILE);
        const loaded = loadDeployment(TEST_FILE);

        expect(loaded).toEqual(deployment);
    });

    it('should return null when loading non-existent file', () => {
        const loaded = loadDeployment('non-existent.json');
        expect(loaded).toBeNull();
    });
});
