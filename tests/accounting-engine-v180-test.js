'use strict';

const assert = require('node:assert/strict');
const {
  inferItemType,
  resolvePosting,
  valueInventoryMovements
} = require('../lib/accounting-engine');

assert.equal(inferItemType({counterpartyName:'Azercell Telekom MMC',description:'Mobil rabitə xidməti'}),'Xidmət');
assert.equal(inferItemType({description:'Mühərrik ehtiyat hissələri və materiallar'}),'Mal');

const rules=[
  {id:1,priority:10,active:1,direction:'Gələn',item_type:'Xidmət',match_field:'counterparty',match_value:'Azercell',account_code:'721.03',subkonto_id:7}
];
const azercell=resolvePosting({direction:'Gələn',counterpartyName:'Azercell Telekom MMC',description:'Aylıq mobil rabitə',defaultWarehouseId:1},rules);
assert.equal(azercell.itemType,'Xidmət');
assert.equal(azercell.accountCode,'721.03');
assert.equal(azercell.subkontoId,7);
assert.equal(azercell.needsReview,false);

const goods=resolvePosting({direction:'Gələn',itemType:'Mal',description:'Avtomobil detalı',defaultWarehouseId:4,inventoryAccount:'205.01',suspenseAccount:'721.99'},[]);
assert.equal(goods.accountCode,'205.01');
assert.equal(goods.warehouseId,4);

const unknown=resolvePosting({direction:'Gələn',description:'Təsnif edilməmiş sətir',defaultWarehouseId:4,suspenseAccount:'721.99'},[]);
assert.equal(unknown.accountCode,'721.99');
assert.equal(unknown.needsReview,true);

const average=valueInventoryMovements([
  {id:1,direction:'IN',quantity:10,totalCost:100},
  {id:2,direction:'IN',quantity:10,totalCost:300},
  {id:3,direction:'OUT',quantity:5}
],'AVERAGE');
assert.equal(average.movements[2].totalCost,100);
assert.equal(average.quantityOnHand,15);
assert.equal(average.inventoryValue,300);

const fifo=valueInventoryMovements([
  {id:1,direction:'IN',quantity:10,totalCost:100},
  {id:2,direction:'IN',quantity:10,totalCost:300},
  {id:3,direction:'OUT',quantity:12}
],'FIFO');
assert.equal(fifo.movements[2].totalCost,160);
assert.equal(fifo.quantityOnHand,8);
assert.equal(fifo.inventoryValue,240);

const shortage=valueInventoryMovements([
  {id:1,direction:'IN',quantity:2,totalCost:20},
  {id:2,direction:'OUT',quantity:5}
],'FIFO');
assert.equal(shortage.movements[1].shortageQuantity,3);
assert.equal(shortage.movements[1].totalCost,50);

console.log('accounting engine v1.8.0: OK');
