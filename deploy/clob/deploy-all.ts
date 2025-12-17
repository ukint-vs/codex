import { deployL2 } from './deploy-l2';
import { deployL1 } from './deploy-l1';

async function main() {
    console.log('🚀 Starting Full Testnet Deployment...');
    
    try {
        console.log('\n--- Phase 1: Gear L2 Deployment ---');
        await deployL2();
        
        console.log('\n--- Phase 2: Ethereum L1 Deployment ---');
        await deployL1();
        
        console.log('\n✅ Deployment Complete!');
    } catch (error) {
        console.error('\n❌ Deployment Failed:', error);
        process.exit(1);
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}
