# dsh-mcp-market

**Navegue, verifique e sincronize o mercado MCP do ModelScope dentro do DeepSeek Harness — e instale,
ative, desative ou remova servidores MCP com um clique.**

[English](README.md) · [简体中文](README-zh.md) · [Español](README-es.md) · [Português](README-pt.md) · [हिन्दी](README-hi.md)

Adiciona um painel **Mercado MCP** à barra lateral do DSH Web. Obtém o catálogo de
[modelscope.cn/mcp](https://modelscope.cn/mcp) (mais de 12.000 serviços), traduz cada registro em uma
configuração MCP compatível com o DSH e grava no `cordis.patch.yml` do seu perfil, onde o DSH recarrega
a quente via HMR.

## Features

- **Aba Mercado** — pesquisar, ordenar (relevância / estrelas / popularidade / atualização recente),
  filtrar por categoria e por hospedado ou local, e instalar. Os nomes de categoria são os rótulos
  chineses do ModelScope (a API só devolve slugs em inglês; as 100 categorias vêm incluídas) — passe o
  cursor sobre uma para ver o slug original. A ordenação e os filtros usam o menu suspenso nativo do
  DSH, combinando com os botões ao lado.
- **Aba Instalados** — cada servidor MCP com estado ao vivo (em execução / falhou / carregando /
  desativado), número de ferramentas registradas e ações: ativar, desativar, testar conexão, remover.
- **Sincronização do catálogo** — cria um índice local para que pesquisar, ordenar e filtrar não
  acessem a rede a cada tecla. O ModelScope limita consultas anônimas a 300 linhas, então a
  sincronização percorre um leque de palavras-chave (~160 requisições) e atinge ~67% do catálogo de
  12.500 serviços; o painel informa a cobertura real em vez de fingir que o índice está completo. As
  diferenças incrementais indicam o que foi adicionado, atualizado ou removido.
  A busca cobre o resto: ao digitar uma consulta, o painel também consulta o mercado ao vivo.
- **Sincronização agendada** — além do botão manual, o índice é baixado de novo automaticamente em
  um intervalo, e ao iniciar quando o cache falta ou está desatualizado. Tudo é configurável e o
  painel mostra quando foi a última e quando será a próxima.
- **Sem conta no ModelScope** — a API pública não exige login e cerca de 76% dos serviços indexados
  já trazem uma configuração que o DSH usa diretamente (medição sobre 8.377 registros; veja abaixo).
- **Convive com outros plugins** — reescreve apenas o seu próprio bloco marcado no
  `cordis.patch.yml`; as linhas de outros plugins são preservadas byte a byte.

## Install

```bash
dsh plugin --profile web add dsh-mcp-market
```

Reinicie o perfil web uma vez e abra **Mercado MCP** na barra lateral esquerda.

## How it works

Um servidor MCP é uma linha em `~/.dsh/profiles/<profile>/cordis.patch.yml`:

```yaml
- id: mcp-market-<serverName>
  name: "@deepseek-ai/dsh-mcp-client"
  # disabled: true          # ← «desativar» é exatamente este campo
  config:
    serverName: <serverName>
    transport: stdio | streamable-http
```

Instalar acrescenta uma linha, remover tira uma e desativar define `disabled: true`. As alterações
entram em vigor via HMR.

As implantações **hospedadas** do ModelScope exigem conta e retornam um endereço SSE que o DSH não
suporta; este plugin não as suporta de propósito.

### Mapeamento de configuração

| Campo do ModelScope | Configuração do DSH |
|---|---|
| `StreamableHTTPServerConfig` | `transport: streamable-http` + `url` (+ `headers`) |
| `ServerConfig` | `transport: stdio` + `command` / `args` / `env` |
| `SSEServerConfig` | *não suportado* — o DSH não tem transporte SSE; o painel os marca como «não suportado» |
| `EnvSchema` | formulário na instalação; valores de exemplo como `<required>` nunca são gravados |

A prioridade é remoto → local. Medido sobre os 8.377 registros do índice:

| Configuração encontrada | Proporção |
|---|---|
| `ServerConfig` (local, stdio) | 67,5% |
| `StreamableHTTPServerConfig` (endereço direto) | 8,4% |
| Apenas `SSEServerConfig` → **não instalável** | 24,1% |

**75,9% dos serviços indexados são instaláveis**; 23,4% precisam de pelo menos uma variável de ambiente.

### Por que o índice para em ~67%, e o que a sincronização realmente faz

A API pública impõe um **limite de deslocamento de 300 para requisições anônimas**: quando
`(PageNumber − 1) × PageSize` chega a 300, todas as páginas seguintes voltam vazias *e* o `TotalCount`
cai para 0. Medido em 11 combinações de largura de página e número de página, o corte fica sempre
exatamente em 300 — é uma cota do servidor, não um erro de paginação. Uma sincronização que apenas
pagina até esgotar para em 300 de 12.520 serviços (2,4%).

O que funciona é `Query`: é uma busca real por palavra-chave (`finance` → 20 resultados,
`搜索` → 222). Então a sincronização percorre um leque de palavras-chave (as 26 letras, 10 dígitos,
~50 termos comuns e os nomes de categoria do próprio catálogo) e une os resultados por id:

| Palavras-chave | Indexados | Cobertura | Requisições |
|---|---|---|---|
| 36 (letras + dígitos) | 7.132 | 57,0% | 100 |
| 80 | 8.331 | 66,6% | ~155 |
| 160 | 8.403 | 67,1% | 236 |

O ganho achata rápido — as últimas 80 palavras trouxeram 72 registros — então a lista padrão para em
96. Uma sincronização leva cerca de 4 minutos e ~160 requisições.

A lacuna restante é coberta na busca: ao digitar uma consulta, o painel também consulta o mercado ao
vivo e combina os dois conjuntos de resultados.

## Scheduled sync

Dois disparos compartilham o mesmo bloqueio: uma sincronização manual e uma agendada nunca coincidem.

| Disparo | Quando | Padrão |
|---|---|---|
| **Manual** | Ao clicar em **Sincronizar catálogo** | sempre disponível |
| **Inicialização** | Uma vez por boot, só se o cache faltar ou tiver mais de 6 horas | ativo, 15 s após iniciar |
| **Intervalo** | A cada `intervalHours` enquanto o DSH roda | a cada 24 h |

Adicione uma linha com o **mesmo `id`** ao `cordis.patch.yml` do seu perfil; a camada do perfil tem
prioridade e um patch substitui todo o `config`, então reescreva cada chave que quiser manter:

```yaml
- id: mcp-market
  name: dsh-mcp-market
  config:
    autoSync: false        # desliga o intervalo por completo
    intervalHours: 12      # 0.25 – 168
    syncOnStart: true
    startDelayMs: 30000
    maxRequests: 400       # orçamento de requisições do leque de palavras-chave
```

As alterações recarregam a quente via HMR. A linha de estado do painel sempre mostra o agendamento
atual e a última sincronização. Os temporizadores estão ligados à vida do plugin e são cancelados ao
descarregá-lo.

## Compatibility

| Superfície | Estado |
|---|---|
| DeepSeek Harness | `0.1.7-rc.1` (verificado) |
| Node | `^22.19.0 \|\| >=24.0.0` |
| Plataformas | Todas (ESM puro, sem código nativo) |
| Modelo | Qualquer (sem interação com modelos) |

## Development

```bash
node test/patch.test.mjs         # segurança do arquivo de configuração
node test/market.test.mjs        # filtragem, conversão, comparação + catálogo ao vivo
node test/scheduler.test.mjs     # agendamento: limites de config, ciclo de vida, concorrência
node test/keywords.test.mjs      # leque de palavras-chave + o limite anônimo de 300
node test/status.test.mjs        # estado do loader, fase de fiber, número de ferramentas
node test/client-render.test.mjs # renderiza o bundle do cliente sem navegador + guardas de código
node test/wire-contract.test.mjs # paridade manifest ↔ contribuição + nomes reservados
```

`market.test.mjs` e `keywords.test.mjs` precisam de rede; use `SKIP_ONLINE=1` para rodar só as seções
offline.

## Uninstall

```bash
dsh plugin --profile web remove dsh-mcp-market
```

Os servidores que você instalou permanecem no `cordis.patch.yml` (são linhas MCP normais do DSH).
Remova-os pela aba Instalados se quiser deixar o arquivo limpo.

## License

MIT
