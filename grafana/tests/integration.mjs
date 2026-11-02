// Integração real com InfluxDB 2.x/Flux. Cria e remove um bucket temporário.
// INFLUX_TEST_URL=http://127.0.0.1:8086 INFLUX_TEST_ORG=... INFLUX_TEST_TOKEN=... node grafana/tests/integration.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const url = process.env.INFLUX_TEST_URL;
const token = process.env.INFLUX_TEST_TOKEN;
const org = process.env.INFLUX_TEST_ORG;
assert(url && token && org, 'Defina INFLUX_TEST_URL, INFLUX_TEST_ORG e INFLUX_TEST_TOKEN para uma instância de teste.');
const dashboard = JSON.parse(readFileSync(new URL('../dashboards/iotrace.json', import.meta.url)));
const headers = { Authorization: `Token ${token}`, 'Content-Type': 'application/json' };
async function request(path, options = {}) {
  const response = await fetch(`${url}${path}`, { ...options, headers: { ...headers, ...options.headers } });
  const body = await response.text();
  assert(response.ok, `${response.status}: ${body}`);
  return body;
}
// CSV Flux: campos podem conter vírgulas e aspas; ignora as anotações do protocolo.
function records(csv) {
  const rows = csv.trim().split(/\r?\n/).filter(s => s && !s.startsWith('#'));
  const parse = s => {
    const values = [];
    let value = '', quoted = false;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '"') {
        if (quoted && s[i + 1] === '"') { value += '"'; i++; }
        else quoted = !quoted;
      } else if (s[i] === ',' && !quoted) { values.push(value); value = ''; }
      else value += s[i];
    }
    return [...values, value];
  };
  let names = [];
  return rows.flatMap(line => {
    const values = parse(line);
    if (values[1] === 'result') { names = values; return []; }
    return [Object.fromEntries(names.map((key, i) => [key, values[i]]))];
  });
}
const organization = JSON.parse(await request(`/api/v2/orgs?org=${encodeURIComponent(org)}`)).orgs[0];
assert(organization, 'Organização de teste não encontrada.');
const bucketName = `iotrace-dashboard-test-${randomUUID()}`;
const bucket = JSON.parse(await request('/api/v2/buckets', { method: 'POST', body: JSON.stringify({ orgID: organization.id, name: bucketName, retentionRules: [{ type: 'expire', everySeconds: 3600 }] }) }));
const now = Date.now();
const normal = {
  pressao_oleo_bar: 4.61, temperatura_arrefecimento_c: 95.13, rotacao_motor_rpm: 5565,
  ...Object.fromEntries(['de', 'dd', 'te', 'td'].flatMap(w => [[`temperatura_pneu_${w}_c`, 92.32], [`pressao_pneu_${w}_bar`, 1.98], [`temperatura_freio_${w}_c`, 499.42]])),
};
const intFields = new Set(['rotacao_motor_rpm', 'sequencia', 'volta', 'indice_ponto']);
const escapeTag = value => String(value).replace(/[ ,=]/g, '\\$&');
function line(time, sequence, { scenario = 'normal', segment = 'Curva do Sol', car = 'CAR_001', client = 'CLIENTE_001', session = 'sessao-teste', readings = normal, partial = false } = {}) {
  const tags = { cliente_id: client, veiculo_id: car, cenario: scenario, pista: 'interlagos', trecho: segment, topic: `clientes/${client}/veiculos/${car}/telemetria` };
  const fields = { ...readings, sequencia: sequence, sessao_id: session, volta: Math.floor(sequence / 43) + 1, indice_ponto: sequence % 43, posicao_x: 200, posicao_y: 269 };
  if (!partial) Object.assign(fields, { resistencia_pt100_ohm: 136.657, tensao_oleo_v: 2.344, ...Object.fromEntries(['de', 'dd', 'te', 'td'].map(w => [`tensao_pneu_${w}_v`, 2.084])) });
  return `telemetria_veicular,${Object.entries(tags).map(([k, v]) => `${k}=${escapeTag(v)}`).join(',')} ${Object.entries(fields).map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(v) : `${v}${intFields.has(k) ? 'i' : ''}`}`).join(',')} ${Math.round(time)}`;
}
async function write(lines) {
  await request(`/api/v2/write?org=${encodeURIComponent(org)}&bucket=${bucket.id}&precision=ms`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: lines.join('\n') });
}
async function query(panelId, { client = 'CLIENTE_001', car = 'CAR_001', sensor = 'pressao_oleo_bar', time = now } = {}) {
  let query = dashboard.panels.find(p => p.id === panelId).targets[0].query
    .replaceAll('${bucket}', bucketName).replaceAll('${cliente:doublequote}', JSON.stringify(client))
    .replaceAll('${veiculo:doublequote}', JSON.stringify(car)).replaceAll('${sensor:doublequote}', JSON.stringify(sensor));
  const clock = `option now = () => time(v: "${new Date(time).toISOString()}")\n`;
  if (query.startsWith('import ')) query = query.replace(/^(?:import "[^"]+"\n)+/, imports => imports + clock);
  else query = clock + query;
  return records(await request(`/api/v2/query?org=${encodeURIComponent(org)}`, { method: 'POST', headers: { Accept: 'application/csv' }, body: JSON.stringify({ query, type: 'flux' }) }));
}
try {
  let rows = await query(1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tem_coleta, 'false');
  assert.equal(rows[0].condicao, '3');
  assert.equal(rows[0].pressao_oleo_bar, '');
  assert.equal((await query(4))[0].Estado, 'Sem sinal');
  console.log('OK · sem dados: estado explícito, sem valores inventados');

  // 8 mil coletas em 800 segundos, 129 grupos de tags, duas sessões e duplicatas.
  const mass = Array.from({ length: 8000 }, (_, i) => line(now - 802000 + i * 100, i + 1, {
    scenario: ['normal', 'atencao', 'critico'][i % 3], segment: `Trecho ${i % 43}`,
    readings: i % 3 === 2 ? { ...normal, pressao_oleo_bar: 1.7 } : normal,
    session: i < 4000 ? 'sessao-anterior' : 'sessao-nova',
  }));
  mass.push(line(now - 1500, 8001), line(now - 1500, 8001));
  mass.push(line(now - 100, 99999, { car: 'CAR_002', readings: { ...normal, pressao_oleo_bar: 1 } }));
  mass.push(line(now - 100, 88888, { client: 'CLIENTE_002' }));
  for (let i = 0; i < mass.length; i += 1000) await write(mass.slice(i, i + 1000));
  rows = await query(1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sequencia, '8001');
  assert.equal(rows[0].sessao_id, 'sessao-teste');
  assert.equal(rows[0].trecho, 'Curva do Sol');
  assert.equal(rows[0].condicao, '0');
  assert.equal(rows[0].pressao_oleo_bar, '4.61');
  assert.equal((await query(4))[0].Estado, 'Normal');
  const trend = await query(5);
  assert(trend.length > 0 && trend.length <= 31, `Tendência ilimitada: ${trend.length}`);
  const map = decodeURIComponent(rows[0].mapa_pista.split(',').slice(1).join(','));
  assert(map.includes('cx="200" cy="269"'));
  assert.equal((await query(1, { car: 'CAR_002' }))[0].sequencia, '99999');
  console.log(`OK · 8.000 coletas: 1 snapshot, ${trend.length} pontos, isolamento de cliente/veículo, duplicatas e mapa X/Y`);

  await write([line(now - 1000, 1, { scenario: 'critico', session: 'reiniciada', readings: { ...normal, pressao_oleo_bar: 2.1, temperatura_freio_de_c: 651, temperatura_pneu_dd_c: 108, pressao_pneu_dd_bar: 2.36, temperatura_arrefecimento_c: 108 } })]);
  rows = await query(1);
  assert.equal(rows[0].sequencia, '1');
  assert.equal(rows[0].sessao_id, 'reiniciada');
  assert.equal(rows[0].estado_pressao_oleo_bar, '2');
  assert.equal(rows[0].estado_temperatura_freio_de_c, '2');
  assert.equal(rows[0].estado_temperatura_pneu_dd_c, '1');
  assert.equal(rows[0].alertas_criticos, '2');
  const alerts = await query(4);
  assert.equal(alerts.length, 5);
  assert.equal(alerts[0].Estado, 'Crítico');
  assert.equal(alerts[4].Estado, 'Atenção');
  console.log('OK · sessão reiniciada e 5 alertas com severidades do protótipo');

  rows = await query(1, { time: now + 30000 });
  assert.equal(rows[0].condicao, '3');
  assert.equal(rows[0].estado_de, '3');
  assert.equal((await query(4, { time: now + 30000 }))[0].Estado, 'Sem sinal');
  assert.equal((await query(4, { time: now + 960000 }))[0].Estado, 'Sem sinal');
  console.log('OK · perda de sinal e expiração da janela de 15 min');

  await write([line(now - 500, 2, { scenario: 'parcial', session: 'parcial', readings: { pressao_oleo_bar: 4.5 }, partial: true })]);
  rows = await query(1);
  assert.equal(rows[0].pressao_oleo_bar, '4.5');
  assert.equal(rows[0].temperatura_pneu_de_c, '');
  assert.equal(rows[0].estado_temperatura_pneu_de_c, '4');
  assert.equal(rows[0].leituras_ausentes, '14');
  assert.equal((await query(4)).length, 14);
  console.log('OK · coleta parcial: não reaproveita leituras de coletas antigas');
} finally {
  await request(`/api/v2/buckets/${bucket.id}`, { method: 'DELETE' });
}
