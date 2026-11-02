// Fonte do JSON provisionável. Execute: node grafana/build-dashboard.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const colors = { normal: '#23754f', attention: '#ad7220', critical: '#c90829', stale: '#92949e', text: 'text', muted: '#80828e', line: '#d5d5dd' };
const wheels = [['de', 'Dianteira esquerda'], ['dd', 'Dianteira direita'], ['te', 'Traseira esquerda'], ['td', 'Traseira direita']];
// Faixas e regra de severidade do protótipo index.html (função severity).
const channels = [
  ['pressao_oleo_bar', 'Pressão do óleo', 'bar', 2, 2.5, 6.5, 8],
  ['temperatura_arrefecimento_c', 'Arrefecimento', 'celsius', 1, 75, 105, 120],
  ['rotacao_motor_rpm', 'Rotação do motor', 'rotrpm', 0, 2000, 8000, 10000],
  ...wheels.flatMap(([w, name]) => [
    [`temperatura_pneu_${w}_c`, `Pneu ${w.toUpperCase()}`, 'celsius', 1, 70, 105, 140, name],
    [`pressao_pneu_${w}_bar`, `Pressão ${w.toUpperCase()}`, 'bar', 2, 1.6, 2.3, 3, name],
    [`temperatura_freio_${w}_c`, `Freio ${w.toUpperCase()}`, 'celsius', 0, 100, 650, 800, name],
  ]),
].map(([field, label, unit, decimals, min, max, axis, wheel]) => ({ field, label, unit, decimals, min, max, axis, wheel }));
const auxiliaries = ['volta', 'sequencia', 'indice_ponto', 'posicao_x', 'posicao_y', 'resistencia_pt100_ohm', 'tensao_oleo_v', ...wheels.map(([w]) => `tensao_pneu_${w}_v`)];
const numeric = [...channels.map(c => c.field), ...auxiliaries];
const strings = ['cliente_id', 'veiculo_id', 'cenario', 'pista', 'trecho', 'sessao_id'];
const q = JSON.stringify;
const influx = { type: 'influxdb', uid: '${datasource}' };
const shared = { type: 'datasource', uid: '-- Dashboard --' };
const source = (window = '-15m') => `from(bucket: "${'${bucket}'}")
  |> range(start: ${window}, stop: now())
  |> filter(fn: (r) => r._measurement == "telemetria_veicular")
  |> filter(fn: (r) => r.cliente_id == ${'${cliente:doublequote}'} and r.veiculo_id == ${'${veiculo:doublequote}'})`;
const unitLabel = c => c.unit === 'celsius' ? '°C' : c.unit === 'rotrpm' ? 'RPM' : 'bar';
// Grafana reconhece uma URL absoluta procurando ":/". Preservar o http:// do
// namespace SVG evita que ele prefixe public/build/ em uma data URI válida.
const encodeSvg = s => encodeURIComponent(s).replaceAll("'", '%27').replaceAll('%3A%2F%2F', '://');

// last() reduz cada série na origem antes do pivot. O sort global elimina os
// grupos de trecho/cenário antigos, selecionando UMA coleta inteira por veículo.
const snapshot = `import "array"
import "internal/debug"
severity = (value, low, high, brake) =>
  if value >= low and value <= high then 0
  else if (brake and value > high) or value > high * 1.1 or value < low * 0.9 then 2
  else 1
statusText = (code) => if code == 0 then "Normal" else if code == 1 then "Atenção" else if code == 2 then "Crítico" else if code == 3 then "Sem sinal" else "Sem leitura"
maxStatus = (a, b) => if a > b then a else b
raw = ${source()}
  |> filter(fn: (r) => contains(value: r._field, set: ${q([...numeric, 'sessao_id'])}))
  |> last()
  |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")
  |> group(columns: [])
  |> map(fn: (r) => ({
    _time: r._time, tem_coleta: true,
${numeric.map(f => `    ${f}: if exists r.${f} then float(v: r.${f}) else debug.null(type: "float"),`).join('\n')}
${strings.map(f => `    ${f}: if exists r.${f} then r.${f} else "—",`).join('\n')}
  }))
empty = array.from(rows: [{
  _time: time(v: 0), tem_coleta: false,
${numeric.map(f => `  ${f}: debug.null(type: "float"),`).join('\n')}
${strings.map(f => `  ${f}: "—",`).join('\n')}
}])
latest = union(tables: [raw, empty])
  |> group(columns: [])
  |> sort(columns: ["_time"], desc: true)
  |> limit(n: 1)
  |> map(fn: (r) => ({r with idade_s: if r.tem_coleta then float(v: int(v: now()) - int(v: r._time)) / 1000000000.0 else -1.0}))
states = latest |> map(fn: (r) => ({r with
${channels.map(c => `  estado_${c.field}: if not r.tem_coleta or r.idade_s > 10.0 then 3 else if exists r.${c.field} then severity(value: r.${c.field}, low: ${c.min.toFixed(1)}, high: ${c.max.toFixed(1)}, brake: ${c.field.startsWith('temperatura_freio')}) else 4,
  leitura_${c.field}: if exists r.${c.field} then string(v: r.${c.field}) + " ${unitLabel(c)}" else "Sem leitura",`).join('\n')}
}))
snapshot = states |> map(fn: (r) => ({r with
  condicao: ${channels.reduce((acc, c) => `maxStatus(a: ${acc}, b: r.estado_${c.field})`, '0')},
  alertas_criticos: ${channels.map(c => `(if r.estado_${c.field} == 2 then 1 else 0)`).join(' + ')},
  alertas_atencao: ${channels.map(c => `(if r.estado_${c.field} == 1 then 1 else 0)`).join(' + ')},
  leituras_ausentes: ${channels.map(c => `(if r.estado_${c.field} == 4 then 1 else 0)`).join(' + ')},
  conexao: if not r.tem_coleta then "Nenhuma coleta em 15 min" else if r.idade_s > 10.0 then "Sem sinal · dados desatualizados" else "Ao vivo · recebendo telemetria",
  coleta_em: if r.tem_coleta then string(v: r._time) else "Aguardando envio do veículo",
${wheels.map(([w]) => `  estado_${w}: maxStatus(a: maxStatus(a: r.estado_temperatura_pneu_${w}_c, b: r.estado_pressao_pneu_${w}_bar), b: r.estado_temperatura_freio_${w}_c),`).join('\n')}
}))
`;

const thresholds = c => ({ mode: 'absolute', steps: [
  { color: colors.critical, value: null },
  { color: colors.attention, value: c.min * 0.9 },
  { color: colors.normal, value: c.min },
  { color: colors.attention, value: c.max + 0.000001 },
  { color: colors.critical, value: (c.field.startsWith('temperatura_freio') ? c.max : c.max * 1.1) + 0.000001 },
] });
const statusMapping = [{ type: 'value', options: Object.fromEntries([
  ['Normal', colors.normal], ['Atenção', colors.attention], ['Crítico', colors.critical], ['Sem sinal', colors.stale], ['Sem leitura', colors.critical],
].map(([text, color], i) => [i, { text, color, index: i }])) }];
const override = (name, props) => ({ matcher: { id: 'byName', options: name }, properties: Object.entries(props).map(([id, value]) => ({ id, value })) });
const fieldConfig = { defaults: { noValue: '—', color: { mode: 'thresholds' } }, overrides: [
  ...channels.map(c => override(c.field, { unit: c.unit, decimals: c.decimals, min: 0, max: c.axis, thresholds: thresholds(c) })),
  ...[...channels.map(c => `estado_${c.field}`), ...wheels.map(([w]) => `estado_${w}`), 'condicao'].map(f => override(f, { mappings: statusMapping, thresholds: { mode: 'absolute', steps: [{ color: colors.normal, value: null }, { color: colors.attention, value: 1 }, { color: colors.critical, value: 2 }, { color: colors.stale, value: 3 }, { color: colors.critical, value: 4 }] } })),
  ...['volta', 'sequencia', 'indice_ponto'].map(f => override(f, { decimals: 0, unit: 'none' })),
  override('idade_s', { decimals: 1, unit: 'suffix:s', mappings: [{ type: 'value', options: { '-1': { text: '—' } } }] }),
] };
const panels = [];
const base = (id, title, type, x, y, w, h, description = '') => ({ id, title, type, description, gridPos: { x, y, w, h }, fieldConfig: structuredClone(fieldConfig) });
const target = query => [{ refId: 'A', datasource: influx, query }];
const reuse = () => ({ datasource: shared, targets: [{ refId: 'A', datasource: shared, panelId: 1, withTransforms: false }] });
const element = (name, type, x, y, w, h, config = {}, extra = {}) => ({ name, type, placement: { left: x, top: y, width: w, height: h }, constraint: { horizontal: 'scale', vertical: 'scale' }, background: { color: { fixed: 'transparent' } }, config, ...extra });
const text = (label, x, y, w, h = 20, size = 12, color = colors.text, align = 'left') => element(label, 'text', x, y, w, h, { text: { mode: 'fixed', fixed: label }, size, align, valign: 'middle', color: { fixed: color } });
const metric = (field, x, y, w, h = 32, size = 24, statusField, align = 'left') => element(field, 'metric-value', x, y, w, h, { text: { mode: 'field', field }, size, align, valign: 'middle', color: statusField ? { field: statusField } : { fixed: colors.text } });
// scale usa distâncias percentuais às QUATRO bordas; width/height são ignorados.
const canvas = (panel, width, height, elements) => ({ ...panel, ...reuse(), options: { inlineEditing: false, showAdvancedTypes: false, panZoom: false, zoomToContent: false, tooltip: { mode: 'none' }, root: { name: 'IoTrace', type: 'frame', background: { color: { fixed: 'transparent' } }, elements: elements.map(e => ({ ...e, placement: { left: e.placement.left / width * 100, top: e.placement.top / height * 100, right: (width - e.placement.left - e.placement.width) / width * 100, bottom: (height - e.placement.top - e.placement.height) / height * 100 } })) } } });

const context = canvas(base(1, 'Telemetria em tempo real', 'canvas', 0, 0, 24, 3, 'Coleta mais recente dos últimos 15 minutos. Sem sinal após 10 s; horários das coletas em UTC.'), 1560, 52, [
  text('IoTrace', 8, 0, 110, 40, 28, colors.critical),
  metric('veiculo_id', 142, 0, 160, 28, 22), metric('cliente_id', 142, 28, 160, 20, 11),
  text('VOLTA', 330, 0, 80, 18, 10, colors.muted), metric('volta', 330, 18, 80, 28, 22),
  text('TRECHO / PISTA', 440, 0, 280, 18, 10, colors.muted), metric('trecho', 440, 18, 280, 28, 17),
  metric('conexao', 760, 0, 410, 26, 16, 'condicao'), metric('coleta_em', 760, 26, 410, 22, 11),
  text('IDADE DA COLETA', 1200, 0, 150, 18, 10, colors.muted), metric('idade_s', 1200, 18, 150, 28, 22),
  text('SEQUÊNCIA', 1390, 0, 150, 18, 10, colors.muted), metric('sequencia', 1390, 18, 150, 28, 22),
]);
context.datasource = influx;
context.targets = target(snapshot + '\nsnapshot |> yield(name: "coleta_atual")');
panels.push(context);

const carSvg = readFileSync(join(dir, 'assets/monoposto.svg'), 'utf8');
const carElements = [element('Monoposto IoTrace', 'rectangle', 275, 26, 210, 310, {}, { background: { image: { mode: 'fixed', fixed: 'data:image/svg+xml,' + encodeSvg(carSvg) }, size: 'contain' } }),
  text('↑ FRENTE', 300, 0, 160, 20, 10, colors.muted, 'center'),
  text('PNEUS E FREIOS · ÚLTIMA COLETA', 12, 344, 500, 20, 10, colors.muted),
];
wheels.forEach(([w, label], i) => {
  const x = i % 2 ? 508 : 8, y = i < 2 ? 24 : 190;
  carElements.push(element(`Cartão ${w}`, 'rectangle', x, y, 244, 140, {}, { background: { color: { fixed: 'rgba(128,128,128,0.04)' } }, border: { color: { fixed: colors.line }, width: 1, radius: 6 } }),
    element(`Indicador ${w}`, 'rectangle', x, y + 8, 3, 124, {}, { background: { color: { field: `estado_${w}` } } }),
    text(`${w.toUpperCase()} · ${label}`, x + 14, y + 9, 224, 20, 12), metric(`estado_${w}`, x + 14, y + 31, 218, 20, 11, `estado_${w}`),
    metric(`temperatura_pneu_${w}_c`, x + 14, y + 54, 115, 32, 27, `estado_temperatura_pneu_${w}_c`),
    metric(`pressao_pneu_${w}_bar`, x + 132, y + 54, 105, 32, 23, `estado_pressao_pneu_${w}_bar`),
    text('Pneu', x + 14, y + 85, 100, 18, 10, colors.muted), text('Pressão', x + 132, y + 85, 100, 18, 10, colors.muted),
    text('Freio', x + 14, y + 112, 70, 18, 11, colors.muted), metric(`temperatura_freio_${w}_c`, x + 100, y + 106, 130, 28, 18, `estado_temperatura_freio_${w}_c`, 'right'));
});
panels.push(canvas(base(2, 'Condição do carro', 'canvas', 0, 3, 12, 12, 'DE/DD: dianteiras; TE/TD: traseiras. Cor e texto identificam a severidade. Faixas do protótipo index.html.'), 760, 368, carElements));
const engine = [];
channels.slice(0, 3).forEach((c, i) => {
  const y = i * 120;
  engine.push(text(c.label.toUpperCase(), 12, y + 6, 250, 20, 11, colors.muted), metric(c.field, 12, y + 28, 252, 48, 34, `estado_${c.field}`),
    metric(`estado_${c.field}`, 12, y + 78, 120, 20, 12, `estado_${c.field}`), text(`Faixa ${c.min}–${c.max} ${unitLabel(c)}`, 12, y + 98, 250, 18, 10, colors.muted));
});
panels.push(canvas(base(3, 'Motor e arrefecimento', 'canvas', 12, 3, 5, 12), 280, 368, engine));

// Unpivot apenas dos 15 estados de uma coleta, nunca da massa de telemetria.
const choose = prop => channels.reduceRight((rest, c) => `if r._field == "estado_${c.field}" then ${prop(c)} else ${rest}`, '"—"');
const alertsQuery = `import "experimental"
${snapshot}
alerts = snapshot
  |> keep(columns: ${q(['_time', ...channels.flatMap(c => [`estado_${c.field}`, `leitura_${c.field}`])])})
  |> experimental.unpivot(otherColumns: ${q(['_time', ...channels.map(c => `leitura_${c.field}`)])})
  |> filter(fn: (r) => r._value == 1 or r._value == 2 or r._value == 4)
  |> map(fn: (r) => ({
    Sensor: ${choose(c => q(c.wheel ? `${c.label} · ${c.wheel}` : c.label))},
    Estado: statusText(code: r._value),
    Leitura: ${choose(c => `r.leitura_${c.field}`)},
    Faixa: ${choose(c => q(`${c.min}–${c.max} ${unitLabel(c)}`))},
    prioridade: r._value,
  }))
summary = snapshot
  |> filter(fn: (r) => r.condicao == 0 or r.condicao == 3)
  |> map(fn: (r) => ({Sensor: if r.condicao == 0 then "15 sensores dentro da faixa" else r.conexao, Estado: statusText(code: r.condicao), Leitura: "—", Faixa: if r.condicao == 0 then "Nenhum alerta ativo" else "Verifique o envio MQTT / Telegraf", prioridade: r.condicao}))
union(tables: [alerts, summary])
  |> group(columns: [])
  |> sort(columns: ["prioridade", "Sensor"], desc: true)
  |> limit(n: 15)
  |> keep(columns: ["Sensor", "Estado", "Leitura", "Faixa"])
  |> yield(name: "alertas_atuais")`;
panels.push({ ...base(4, 'Central de alertas', 'table', 17, 3, 7, 12, 'Somente a última coleta. Críticos primeiro. Sem sinal após 10 s. Indicadores visuais; não cria regras de Grafana Alerting.'), datasource: influx, targets: target(alertsQuery),
  transformations: [{ id: 'organize', options: { indexByName: { Estado: 0, Sensor: 1, Leitura: 2, Faixa: 3 } } }],
  options: { showHeader: true, cellHeight: 'sm', footer: { show: false }, enablePagination: false },
  fieldConfig: { defaults: { custom: { align: 'left', cellOptions: { type: 'auto', wrapText: true }, filterable: false }, noValue: '—' }, overrides: [
    override('Estado', { 'custom.width': 90, 'custom.cellOptions': { type: 'color-text' }, mappings: [{ type: 'value', options: Object.fromEntries(['Normal', 'Atenção', 'Crítico', 'Sem sinal', 'Sem leitura'].map((t, i) => [t, { text: t, color: [colors.normal, colors.attention, colors.critical, colors.stale, colors.critical][i] }])) }] }),
    override('Leitura', { 'custom.width': 104 }), override('Faixa', { 'custom.width': 124 }),
  ] },
});

const trendsQuery = `${source('-60s')}
  |> filter(fn: (r) => r._field == ${'${sensor:doublequote}'})
  |> group(columns: ["_field"])
  |> sort(columns: ["_time"])
  |> aggregateWindow(every: 2s, fn: last, createEmpty: false, timeSrc: "_start")
  |> keep(columns: ["_time", "_field", "_value"])
  |> yield(name: "ultimos_60s")`;
panels.push({ ...base(5, 'Leituras recentes · ${sensor:text}', 'timeseries', 0, 15, 17, 8, 'Janela móvel de 60 s, no máximo 31 pontos. Selecione o sensor no topo. Faixa normal entre os limites indicados. Não conecta lacunas.'), datasource: influx, targets: target(trendsQuery), maxDataPoints: 64, interval: '2s', timeFrom: '1m',
  fieldConfig: { defaults: { noValue: '—', min: 0, color: { mode: 'fixed', fixedColor: colors.critical }, custom: { drawStyle: 'line', lineInterpolation: 'linear', lineWidth: 2, fillOpacity: 6, showPoints: 'auto', spanNulls: false, axisCenteredZero: false, axisColorMode: 'text', axisBorderShow: false, thresholdsStyle: { mode: 'dashed' }, hideFrom: { legend: false, tooltip: false, viz: false } } }, overrides: channels.map(c => override(c.field, { unit: c.unit, decimals: c.decimals, displayName: c.label, 'custom.axisSoftMax': c.axis, thresholds: { mode: 'absolute', steps: [{ color: 'transparent', value: null }, { color: colors.attention, value: c.min }, { color: colors.attention, value: c.max }] } })) },
  options: { legend: { displayMode: 'table', placement: 'bottom', calcs: ['lastNotNull', 'min', 'max'] }, tooltip: { mode: 'single', sort: 'none' } },
});

// X/Y são coordenadas do desenho, não latitude/longitude. Imagem independente de rede.
const trackSvg = readFileSync(join(dir, 'assets/interlagos.svg'), 'utf8');
const [before, after] = trackSvg.split('<!-- POSITION -->');
const trackExpression = `"data:image/svg+xml,${encodeSvg(before + '<circle cx="')}" + string(v: r.posicao_x) + "${encodeSvg('" cy="')}" + string(v: r.posicao_y) + "${encodeSvg('" r="7" fill="#c90829" stroke="white" stroke-width="3"/>' + after)}"`;
context.targets[0].query = snapshot + `
snapshot
  |> map(fn: (r) => ({r with mapa_pista: if r.tem_coleta and exists r.posicao_x and exists r.posicao_y and r.pista == "interlagos" then ${trackExpression} else "data:image/svg+xml,${encodeSvg('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100"><text x="20" y="50" fill="#92949e" font-size="14">Posição indisponível</text></svg>')}"}))
  |> yield(name: "coleta_atual")`;
panels.push(canvas(base(6, 'Posição na pista · última coleta', 'canvas', 17, 15, 7, 8, '43 pontos X/Y de utils/tempo_real/pista.py. O ponto vermelho mostra a última posição recebida; consulte o estado de sinal. Traçado disponível para interlagos.'), 440, 210, [
  element('Interlagos', 'rectangle', 4, 0, 232, 202, {}, { background: { image: { mode: 'field', field: 'mapa_pista' }, size: 'contain' } }),
  text('PISTA', 252, 4, 176, 18, 10, colors.muted), metric('pista', 252, 22, 176, 24, 15),
  text('TRECHO', 252, 54, 176, 18, 10, colors.muted), metric('trecho', 252, 72, 176, 42, 14),
  text('PONTO / VOLTA', 252, 126, 176, 18, 10, colors.muted), metric('indice_ponto', 252, 144, 72, 28, 20), metric('volta', 350, 144, 72, 28, 20),
  metric('conexao', 252, 178, 178, 28, 10, 'condicao'),
]));

const dashboard = {
  uid: 'iotrace-telemetria', title: 'IoTrace | Telemetria em tempo real', description: 'Telemetria operacional baseada no protótipo index.html. Dados atuais e últimos 60 segundos; sem simulação no navegador.',
  tags: ['iotrace', 'telemetria', 'tempo-real'], timezone: 'browser', schemaVersion: 39, version: 2, editable: true,
  graphTooltip: 0, refresh: '2s', time: { from: 'now-1m', to: 'now' }, liveNow: true,
  timepicker: { refresh_intervals: ['2s', '5s', '10s', '30s'], hidden: false }, annotations: { list: [] }, links: [],
  templating: { list: [
    { name: 'datasource', label: 'InfluxDB', type: 'datasource', query: 'influxdb', current: { text: 'InfluxDB - Telemetria', value: 'iotrace-influxdb' }, refresh: 1, multi: false, includeAll: false },
    { name: 'bucket', type: 'constant', query: 'sensores', current: { text: 'sensores', value: 'sensores' }, hide: 2 },
    { name: 'cliente', label: 'Cliente', type: 'query', datasource: influx, query: 'import "influxdata/influxdb/schema"\nschema.tagValues(bucket: "${bucket}", tag: "cliente_id", predicate: (r) => r._measurement == "telemetria_veicular", start: -24h)', definition: 'Clientes com telemetria nas últimas 24h', current: { text: 'CLIENTE_001', value: 'CLIENTE_001' }, refresh: 1, sort: 1, multi: false, includeAll: false, options: [] },
    { name: 'veiculo', label: 'Veículo', type: 'query', datasource: influx, query: 'import "influxdata/influxdb/schema"\nschema.tagValues(bucket: "${bucket}", tag: "veiculo_id", predicate: (r) => r._measurement == "telemetria_veicular" and r.cliente_id == ${cliente:doublequote}, start: -24h)', definition: 'Veículos do cliente selecionado nas últimas 24h', current: { text: 'CAR_001', value: 'CAR_001' }, refresh: 1, sort: 1, multi: false, includeAll: false, options: [] },
    { name: 'sensor', label: 'Sensor · gráfico de 60 s', type: 'custom', query: channels.map(c => `${c.label} : ${c.field}`).join(','), current: { text: channels[0].label, value: channels[0].field }, options: channels.map((c, i) => ({ text: c.label, value: c.field, selected: i === 0 })), multi: false, includeAll: false },
  ] }, panels,
};
writeFileSync(join(dir, 'dashboards/iotrace.json'), JSON.stringify(dashboard, null, 2) + '\n');
console.log(`Gerado grafana/dashboards/iotrace.json · ${panels.length} painéis · ${channels.length} sensores`);
