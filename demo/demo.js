'use strict';

// Scripted stand-in for `npm start`, used only to record demo.gif.
// Reproduces the real CLI's console output (see src/attachments.js and
// src/forms.js for the actual log lines) using sample clients — no
// network calls, no browser, no real credentials.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const clients = [
  {
    uid: '123456789',
    name: 'Jane Doe',
    worker: 1,
    attachments: ['Intake_Form.pdf', 'photo.jpg'],
    form: 'MEDICAL_HEALTH_QUESTIONNAIRE_2023-04-01_98765',
  },
  {
    uid: '987654321',
    name: 'John Smith',
    worker: 2,
    attachments: ['Waiver.pdf', 'ID_Scan.jpg'],
    form: 'LIABILITY_RELEASE_2023-02-14_44210',
  },
];

async function main() {
  console.log('=== WellnessLiving → Jane App Migration Export ===');
  await sleep(300);
  console.log(`[index] Loaded ${clients.length} client(s) from clients.csv`);
  await sleep(200);
  console.log('[index] Loaded 0 existing progress entries');
  await sleep(200);
  console.log(`[index] ${clients.length} client(s) to process`);
  await sleep(400);
  process.stdout.write('? WellnessLiving email: demo@example.com\n');
  await sleep(250);
  process.stdout.write('? WellnessLiving password: ********\n');
  await sleep(400);
  console.log('[index] Spawning 2 worker tab(s)...');
  await sleep(300);
  console.log('[index] Worker logs → logs/worker-N.log');
  await sleep(400);

  for (const c of clients) {
    console.log(`\n[index] Processing client: ${c.name} (uid=${c.uid})`);
    await sleep(300);

    console.log(`  [attachments] uid=${c.uid} — ${c.attachments.length} attachment(s) found`);
    await sleep(300);
    for (const file of c.attachments) {
      console.log(`    [attachments] Downloaded: ${file}`);
      await sleep(250);
    }
    console.log(`  [attachments] uid=${c.uid} — ${c.attachments.length}/${c.attachments.length} downloaded`);
    await sleep(300);

    console.log(`  [forms] uid=${c.uid} — navigating to forms page`);
    await sleep(300);
    console.log(`  [forms] uid=${c.uid} — 1 completed form(s) found, 1 exported`);
    await sleep(250);
    console.log(`    [forms] Exported: ${c.form}.pdf`);
    await sleep(250);
    console.log(`    [forms] Exported: ${c.form}.csv`);
    await sleep(300);

    console.log(
      `[worker-${c.worker}] ✓ ${c.name} — ` +
      `attachments: ${c.attachments.length}/${c.attachments.length}, forms: 1/1`
    );
    await sleep(450);
  }

  await sleep(300);
  console.log('\n=== Run complete ===');
  console.log(`  Clients done:   ${clients.length}`);
  console.log('  Clients errors: 0');
}

main();
