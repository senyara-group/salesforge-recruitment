// Local fixtures only. Reuses the repository's real Chrome/Edge layout harness.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { findBrowser, serveFrontend, launchBrowser, openPage, MEASURE_HELPERS } = require('./check-mobile-layout');
const { applicationMoves } = require('../utils/pipelineSummary');
const { stageForStatut } = require('../utils/pipelineQuery');
const VIEWPORTS = [[1280, 900], [1440, 900], [768, 1024], [390, 844], [430, 932]];
const cards = Array.from({ length: 18 }, (_, i) => {
  const statut = ['envoyee', 'vu', 'contacte', 'entretien', 'offre'][i % 5];
  return { id: String(i + 1), name: 'Camille Exemple', role: 'Account Executive', av: 'CE', bg: '#1340E0',
    tags: ['Prospection', 'Relation client'], offre_title: 'Responsable commercial grands comptes', statut,
    score: 85, score_adn: 80, created_at: new Date(Date.UTC(2026, 9, 4 - i)).toISOString(), moves: applicationMoves(statut) };
});
const stages = ['nouveau', 'vu', 'contacte', 'entretien', 'offre', 'termine'];
const pageData = Object.fromEntries(stages.map(key => [key, cards.filter(c => stageForStatut(c.statut) === key)]));
const stats = { recues: 18, recues_new: 5, pipeline: 18, chauds: 3, offres: 2, plan_label: 'Plan Pro', stages: Object.fromEntries(stages.map(key => [key, pageData[key].length])) };
const moves = Object.fromEntries(['envoyee','nouveau','vu','contacte','repondu','entretien','offre','embauche','refusee','retiree'].map(status => [status, applicationMoves(status)]));

async function main() {
  const executable = findBrowser();
  if (!executable) throw new Error('Aucun Chrome/Edge disponible');
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'swipsales-kanban-review-'));
  const server = await serveFrontend();
  const browser = await launchBrowser(executable);
  const report = { artifacts, viewports: {} };
  const timeout = setTimeout(() => { console.error('Délai de validation dépassé'); browser.close(); server.close(); process.exit(2); }, 180000);
  try {
    for (const [width, height] of VIEWPORTS) {
      const page = await openPage(browser, width, height);
      try {
        await page.send('Network.enable');
        await page.send('Network.setBlockedURLs', { urls: ['https://*'] });
        await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `
          window.__reviewErrors=[]; window.addEventListener('error',e=>window.__reviewErrors.push(e.message));
          localStorage.setItem('sf_rec_token','local-test');
          localStorage.setItem('sf_rec_user',JSON.stringify({id:'local-review',role:'recruteur',prenom:'Camille',entreprise:'Équipe commerciale'}));
          window.fetch = async url => new Response(JSON.stringify(String(url).includes('/stats') ? ${JSON.stringify(stats)} : String(url).includes('/abonnements/current') ? {plan:'pro',statut:'actif'} : []), {status:200,headers:{'content-type':'application/json'}});
        ` });
        try {
          await page.navigate(`http://127.0.0.1:${server.address().port}/_spaces/recruteur.html`, 'typeof go === "function" && typeof RecruiterKanban !== "undefined"');
        } catch (error) {
          console.error(await page.evaluate('({url:location.href,ready:document.readyState,errors:window.__reviewErrors,body:document.body?.innerText.slice(0,500)})'));
          throw error;
        }
        await page.evaluate(MEASURE_HELPERS);
        await page.evaluate(`
          USER = { id:'local-review', prenom:'Camille', entreprise:'Équipe commerciale' }; TOKEN = 'local-test'; HAS_PLAN = true;
          window.testStats = ${JSON.stringify(stats)}; window.testPipeline = ${JSON.stringify(pageData)};
          window.reviewMoves = ${JSON.stringify(moves)};
          window.testFailure = false;
          api = async (method, url, payload) => {
            if (url.includes('/status')) {
              if (window.testFailure) throw new Error('Échec simulé');
              const id = url.split('/')[2]; const found = RecruiterKanban.find(window.testPipeline,id);
              const target = found.card.moves.find(move => move.statut === payload.statut);
              const result = { statut:payload.statut, moves:window.reviewMoves[payload.statut] };
              window.testPipeline = RecruiterKanban.put(window.testPipeline,target.stage,{...found.card,...result});
              window.testStats.stages = RecruiterKanban.countsAfter(window.testStats.stages,found.stage,target.stage);
              return result;
            }
            if (url.startsWith('/recruteurs/stats')) return window.testStats;
            if (url.startsWith('/recruteurs/pipeline')) return window.testPipeline;
            if (url.startsWith('/candidatures/recues')) return [{ id:'1', av:'CE', bg:'#1340E0', name:'Camille E.', titre:'Account Executive', score:85, tags:['Vente'] }];
            if (url.startsWith('/offres/mine')) return [{ id:'offer', titre:'Account Executive', statut:'active', lieu:'Lyon', type:'CDI' }];
            return [];
          };
          go('dashboard'); true;
        `);
        await page.evaluate('loadDashboard().then(() => true)');
        const entry = report.viewports[`${width}x${height}`] = {};
        entry.dashboard = await page.evaluate(`({ outside:__layout.outside(document.getElementById('p-dashboard')), width:document.documentElement.scrollWidth, client:document.documentElement.clientWidth, height:document.documentElement.scrollHeight })`);
        assert.deepEqual(entry.dashboard.outside, [], `dashboard overflow ${width}`);
        assert.ok(entry.dashboard.width <= entry.dashboard.client + 1, `document width ${width}`);
        async function screenshot(name) {
          const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
          fs.writeFileSync(path.join(artifacts, `${width}-${name}.png`), Buffer.from(data, 'base64'));
        }
        await screenshot('dashboard-top');
        await page.evaluate('window.scrollTo(0, document.documentElement.scrollHeight / 2); true');
        await screenshot('dashboard-middle');
        await page.evaluate('window.scrollTo(0, document.documentElement.scrollHeight); true');
        entry.scrollY = await page.evaluate('window.scrollY');
        assert.ok(entry.scrollY > 0, `scroll dashboard ${width}`);
        await screenshot('dashboard-bottom');
        await page.evaluate(`go('pipeline'); true`);
        await page.evaluate('loadPipeline().then(() => true)');
        entry.pipeline = await page.evaluate(`({ outside:__layout.outside(document.getElementById('p-pipeline')), columns:document.querySelectorAll('.pipe-col').length, empty:document.querySelectorAll('.pipe-col-empty').length, cards:document.querySelectorAll('.pipe-card').length, draggable:document.querySelectorAll('.pipe-card[draggable=true]').length })`);
        assert.deepEqual(entry.pipeline.outside, [], `pipeline overflow ${width}`);
        assert.equal(entry.pipeline.columns, 6); assert.equal(entry.pipeline.empty, 1); assert.equal(entry.pipeline.cards, 18);
        assert.equal(entry.pipeline.draggable > 0, width >= 1024);
        if (width < 1024) {
          const point = y => [{ x:Math.round(width/2), y, id:0 }];
          await page.send('Input.dispatchTouchEvent', {type:'touchStart',touchPoints:point(Math.round(height*.6))});
          for (let distance = 40; distance <= 240; distance += 40) {
            await page.send('Input.dispatchTouchEvent', {type:'touchMove',touchPoints:point(Math.round(height*.6)-distance)});
            await new Promise(resolve => setTimeout(resolve, 30));
          }
          await page.send('Input.dispatchTouchEvent', {type:'touchEnd',touchPoints:[]});
        } else await page.swipe(0, -250);
        entry.pipelineScrollY = await page.evaluate('window.scrollY');
        if (!entry.pipelineScrollY) console.error(await page.evaluate(`({height:document.documentElement.scrollHeight,viewport:innerHeight,at:document.elementFromPoint(innerWidth/2,innerHeight*.6)?.outerHTML.slice(0,250),pipe:getComputedStyle(document.getElementById('pipe-cols')).cssText,docOverflow:getComputedStyle(document.documentElement).overflow,bodyOverflow:getComputedStyle(document.body).overflow})`));
        assert.ok(entry.pipelineScrollY > 0, `scroll pipeline ${width}`);
        await page.evaluate('window.scrollTo(0,0); true');
        await screenshot('pipeline');
        if (width >= 1024) {
          // Native DragEvents, the real handlers and the real DataTransfer.
          entry.drag = await page.evaluate(`(async () => {
            const card = document.querySelector('[data-card-id="1"]'); const target = document.querySelector('[data-stage="vu"]');
            const data = new DataTransfer();
            card.dispatchEvent(new DragEvent('dragstart', { bubbles:true, cancelable:true, dataTransfer:data }));
            target.dispatchEvent(new DragEvent('dragover', { bubbles:true, cancelable:true, dataTransfer:data }));
            return { highlighted:target.classList.contains('is-target'), dragging:card.classList.contains('is-dragging') };
          })()`);
          assert.equal(entry.drag.highlighted, true); assert.equal(entry.drag.dragging, true);
          await screenshot('drag');
          await page.evaluate(`(async () => { document.querySelector('[data-stage="vu"]').dispatchEvent(new DragEvent('drop', { bubbles:true, cancelable:true, dataTransfer:new DataTransfer() })); await PIPE_WRITER.idle(); return true; })()`);
        } else {
          await page.evaluate(`(async () => { const select = document.querySelector('[data-move-id="1"]'); select.focus(); select.value='vu'; select.dispatchEvent(new Event('change', {bubbles:true})); await PIPE_WRITER.idle(); return true; })()`);
        }
        assert.equal(await page.evaluate(`PIPELINE.vu.some(c => c.id === '1')`), true);
        await screenshot('moved');
        // Keyboard alternative uses real key events on the native select.
        await page.evaluate(`document.querySelector('[data-move-id="2"]').focus(); true`);
        await page.send('Input.dispatchKeyEvent', { type:'keyDown', key:'ArrowDown', code:'ArrowDown', windowsVirtualKeyCode:40 });
        await page.send('Input.dispatchKeyEvent', { type:'keyUp', key:'ArrowDown', code:'ArrowDown', windowsVirtualKeyCode:40 });
        await page.evaluate('PIPE_WRITER.idle().then(() => true)');
        entry.keyboard = await page.evaluate(`({moved:PIPELINE.contacte.some(c=>c.id==='2'),focus:document.activeElement?.dataset?.moveId})`);
        assert.equal(entry.keyboard.moved, true); assert.equal(entry.keyboard.focus, '2');
        await page.evaluate(`loadPipeline().then(() => true)`);
        assert.equal(await page.evaluate(`PIPELINE.vu.some(c=>c.id==='1') && PIPELINE.contacte.some(c=>c.id==='2')`), true);
        await page.evaluate(`window.testFailure = true; movePipelineCard('3','entretien').then(() => true)`);
        assert.equal(await page.evaluate(`PIPELINE.contacte.some(c => c.id === '3') && !PIPELINE.entretien.some(c => c.id === '3') && Object.values(PIPELINE).flat().length === 18`), true);
        await screenshot('rollback');
        await page.evaluate(`window.testPipeline = Object.fromEntries(PIPE_STAGES.map(s => [s.key, []])); loadPipeline().then(() => true)`);
        assert.equal(await page.evaluate(`document.getElementById('pipe-cols').textContent.includes('Aucune candidature reçue')`), true);
        await screenshot('empty');
        console.log(`${width}x${height}: dashboard/scroll, pipeline, déplacement, rollback, vide OK`);
      } finally { await page.close(); }
    }
    fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { clearTimeout(timeout); browser.close(); server.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
