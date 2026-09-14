'use strict';
const { DatabaseSync } = require('node:sqlite');
const assert = require('node:assert/strict');

// Company-scoped user names may repeat across companies, but never within one company.
const master = new DatabaseSync(':memory:');
master.exec(`
  CREATE TABLE companies(id INTEGER PRIMARY KEY, name TEXT, voen TEXT UNIQUE);
  CREATE TABLE user_accounts(id INTEGER PRIMARY KEY, company_id INTEGER, username TEXT, password_hash TEXT, password_salt TEXT, UNIQUE(company_id,username));
  CREATE TABLE invoices(id INTEGER PRIMARY KEY, company_id INTEGER, invoice_no TEXT, voen TEXT, direction TEXT, document_key TEXT UNIQUE);
`);
master.prepare(`INSERT INTO companies VALUES(1,'A MMC','1111111111'),(2,'B MMC','2222222222')`).run();
master.prepare(`INSERT INTO user_accounts VALUES(1,1,'admin','h','s'),(2,2,'admin','h2','s2')`).run();
assert.equal(master.prepare(`SELECT COUNT(*) c FROM user_accounts WHERE username='admin'`).get().c,2);
assert.throws(()=>master.prepare(`INSERT INTO user_accounts VALUES(3,1,'admin','h3','s3')`).run(),/UNIQUE/);

// Invoice business key: same number can exist for different counterparties, but not twice for the same direction/VÖEN.
master.prepare(`INSERT INTO invoices VALUES(1,1,'Q-100','3333333333','Gələn','Q-100|3333333333|Gələn')`).run();
assert.throws(()=>master.prepare(`INSERT INTO invoices VALUES(2,1,'Q-100','3333333333','Gələn','Q-100|3333333333|Gələn')`).run(),/UNIQUE/);
master.prepare(`INSERT INTO invoices VALUES(3,1,'Q-100','4444444444','Gələn','Q-100|4444444444|Gələn')`).run();
master.prepare(`INSERT INTO invoices VALUES(4,1,'Q-100','3333333333','Gedən','Q-100|3333333333|Gedən')`).run();
master.prepare(`INSERT INTO invoices VALUES(5,2,'Q-100','3333333333','Gələn','Q-100|3333333333|Gələn|COMPANY-2')`).run();
console.log('company isolation + invoice business key: OK');
