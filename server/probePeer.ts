import { getIndustryPeers, loadStockMaster } from './src/services/stockMaster.js';
const peers = await getIndustryPeers('600519', '白酒Ⅱ');
console.log('PEERS:', peers.map(p => p.code + p.name + '/' + (p.industry || '?')).join(', '));
const m = await loadStockMaster();
console.log('MASTER len:', m.length, 'withInd:', m.filter(i => i.industry).length);
const mt = m.find(i => i.code === '600519');
console.log('600519 master.industry:', mt && JSON.stringify(mt.industry));
console.log('白酒Ⅱ match:', m.filter(i => i.industry === '白酒Ⅱ').map(i => i.code + i.name).join(', '));
