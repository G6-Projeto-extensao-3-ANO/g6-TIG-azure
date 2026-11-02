# IoTrace — Grafana em tempo real

Dashboard provisionável: [`dashboards/iotrace.json`](dashboards/iotrace.json).
UID: `iotrace-telemetria`. Usa somente Canvas, Table, Time series e a fonte
Dashboard, todos nativos do Grafana. Não precisa instalar plugins, habilitar HTML
sem sanitização, servir imagens ou rodar Node.js no container.

## Usar no seu Docker Compose

No serviço **Grafana que você já tem**, acrescente os volumes e as variáveis abaixo.
Os caminhos à esquerda são relativos ao diretório do seu `docker-compose.yml`;
ajuste-os para apontar para esta pasta do repositório.

```yaml
services:
  grafana:
    # Mantenha os demais campos do serviço existente.
    environment:
      GF_DASHBOARDS_MIN_REFRESH_INTERVAL: 2s
      GF_USERS_DEFAULT_THEME: light
      INFLUXDB_TOKEN: ${INFLUXDB_TOKEN}
    volumes:
      - ./grafana/dashboards:/var/lib/grafana/dashboards:ro
      - ./grafana/provisioning/dashboards/dashboards.yml:/etc/grafana/provisioning/dashboards/iotrace.yml:ro
      - ./grafana/provisioning/datasources/influxdb.yml:/etc/grafana/provisioning/datasources/iotrace.yml:ro
```

Se já monta a pasta `provisioning` inteira, use esse volume existente; não precisa
duplicar os mounts dos arquivos. Preserve os volumes de dados do seu Grafana.

O arquivo [`provisioning/datasources/influxdb.yml`](provisioning/datasources/influxdb.yml)
já existente usa:

| Configuração | Valor |
| --- | --- |
| UID do datasource | `iotrace-influxdb` |
| URL acessível pelo container Grafana | `http://influxdb:8086` |
| Organização InfluxDB | `faculdade` |
| Bucket | `sensores` |
| Token | variável de ambiente `INFLUXDB_TOKEN` no serviço Grafana |
| Linguagem | Flux (InfluxDB 2.x) |

Se sua organização ou nome do serviço InfluxDB for diferente, ajuste esse YAML.
O token precisa ler o bucket e o Grafana deve estar na mesma rede Docker que o
InfluxDB. Caso já tenha um datasource Flux configurado, pode manter o seu e
selecioná-lo no filtro **InfluxDB**, sem montar o YAML de datasources.

Depois de ajustar o Compose, recrie somente o serviço Grafana:

```bash
docker compose up -d --force-recreate grafana
```

Abra **Dashboards → IoTrace → IoTrace | Telemetria em tempo real**, ou acesse
`/d/iotrace-telemetria` no seu Grafana. Para ocupar a tela, use
`/d/iotrace-telemetria?kiosk&theme=light`. O tema claro reproduz o protótipo;
os painéis também funcionam no tema escuro. O layout foi pensado para desktop,
preferencialmente com 1600 px de largura ou mais.

Não é necessário importar o JSON manualmente. O provider recarrega os arquivos
a cada 30 s; mudanças nos volumes e no ambiente exigem recriar o container.
Ele está configurado com `allowUiUpdates: false`: para persistir alterações,
edite a fonte e gere o JSON novamente.

## O que aparece na tela

- Cliente e veículo selecionáveis, volta, trecho, sequência, idade e horário UTC
  da coleta. Os filtros consultam IDs vistos nas últimas 24 h ao abrir a tela;
  recarregue a dashboard para descobrir IDs publicados depois disso.
- Monoposto do `index.html`, com temperatura, pressão e freio de cada roda.
- Pressão do óleo, arrefecimento e RPM, com as mesmas faixas do protótipo.
- Central de alertas da coleta atual, ordenada por gravidade. Em condição normal,
  informa que os 15 sensores estão dentro da faixa.
- Tendência de um dos 15 sensores nos últimos 60 s, com limites da faixa normal.
- Posição mais recente no traçado de Interlagos, usando os 43 pontos X/Y de
  `utils/tempo_real/pista.py`. Não interpreta X/Y como latitude/longitude.

A atualização padrão é **2 s**. Para pausar, desligue o auto refresh no controle
nativo do Grafana. A dashboard é operacional: as consultas sempre usam o instante
atual, com 15 min para procurar a última coleta e 60 s para a tendência.

Após **10 s** sem nova coleta, todos os estados passam a **Sem sinal**, mesmo
que as últimas leituras estejam dentro da faixa. Os números e a posição antigos
continuam visíveis com indicação de sinal perdido. Após 15 min sem dados, mostra
um estado de espera e valores ausentes. Em uma coleta parcial, sensores ausentes
aparecem como **Sem leitura**, sem buscar valores em outras coletas.

Os tempos de volta, piloto, número de corrida e outros dados fictícios do HTML
não são fabricados: o contrato fornecido não contém essas informações. A tela
de histórico do protótipo não foi alterada nem implementada.

Os alertas são **indicadores visuais**; não criam regras ou notificações do
Grafana Alerting. Os limites são referências demonstrativas do protótipo.

## Limites de dados e agrupamento

As tags `trecho` e `cenario` dividem a consulta original em muitas tabelas.
Reduzir com `lastNotNull` apenas no navegador não elimina esses grupos, e enviar
o período inteiro para uma tabela aumenta o trabalho a cada atualização.

Esta dashboard faz três consultas Flux por atualização:

1. Coleta atual: filtra os campos, aplica `last()` por série **antes** do pivot,
   remove o agrupamento, ordena pelo horário e limita a **uma coleta inteira**.
   Carro, motor e pista reutilizam esse resultado pela fonte nativa Dashboard.
2. Alertas: usa a mesma seleção de coleta, calcula as severidades no servidor e
   retorna no máximo **15 linhas**.
3. Tendência: filtra somente o sensor selecionado, une os grupos por `_field` e
   aplica `aggregateWindow(every: 2s, fn: last)` em 60 s, retornando no máximo
   **31 pontos**, independentemente da frequência de envio.

Assim, trocar trecho/cenário, acumular voltas ou reiniciar a sequência em outra
sessão não multiplica os cartões no navegador. A seleção usa `_time`, não o maior
valor de `sequencia`. Duplicatas MQTT persistidas no mesmo timestamp não criam
novos cartões. Não há arrays de amostras nem timers JavaScript acumulados na tela.
O custo no InfluxDB ainda depende da frequência e cardinalidade dentro da janela;
os limites acima controlam os resultados enviados ao navegador.

Referências: [compartilhamento de consultas do Grafana](https://grafana.com/docs/grafana/latest/visualizations/panels-visualizations/query-transform-data/share-query/),
[agrupamento em Flux](https://docs.influxdata.com/influxdb/v2/reference/flux/stdlib/built-in/transformations/group/) e
[painel Canvas](https://grafana.com/docs/grafana/latest/visualizations/panels-visualizations/visualizations/canvas/).

## Manutenção e validação

O JSON já está pronto. Para modificar layout, faixas ou consultas, edite
[`build-dashboard.mjs`](build-dashboard.mjs) e execute com Node.js 18+:

```bash
node grafana/build-dashboard.mjs
```

As imagens SVG de [`assets`](assets) são incorporadas no JSON. A posição é
desenhada com os valores da coleta. Não há arquivos extras para montar no Grafana.

Teste de integração real com uma instância **de teste** InfluxDB 2.x/Flux:

```bash
INFLUX_TEST_URL=http://localhost:8086 \
INFLUX_TEST_ORG=faculdade \
INFLUX_TEST_TOKEN="$TOKEN_DE_TESTE" \
node grafana/tests/integration.mjs
```

O teste cria e remove um bucket temporário; precisa de token com permissão de
gerenciar buckets. Verifica 8 mil coletas, mudanças de tags, isolamento de cliente
e veículo, duplicatas, reinício de sessão, severidades, limite de pontos, mapa,
ausência de dados, perda de sinal e coleta parcial.

Validação executada com **Grafana 13.2.2**, **InfluxDB 2.7.12** e navegador Chromium,
incluindo atualização contínua com dados do simulador deste repositório.
