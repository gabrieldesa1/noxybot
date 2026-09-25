# QA automatizado — Microsoft Forms

Este projeto preenche e processa **5 respostas por execução**, de forma sequencial, usando Playwright.

Os dados ficam em `responses.json`; edite os cinco objetos antes de executar. O script valida os campos e não aceita valores `PREENCHER`.

## Campos

- `variedade`: resposta textual da pergunta 1;
- `pratos`: resposta textual da pergunta 2;
- `servico`: nota inteira de 1 a 6;
- `sugestao`: resposta textual da pergunta 4;
- `satisfacaoGeral`: nota inteira de 1 a 5;
- `satisfacaoVariedade`: nota inteira de 1 a 5.

## Instalação

```powershell
npm install
npx playwright install chromium
Copy-Item .env.example .env
```

Para QA, altere `FORM_URL` no `.env` para a URL do formulário de teste e use `FORM_ENV=test`.

## Dry-run

Preenche as cinco respostas, gera screenshots e **não envia**:

```powershell
npm run qa
```

## Envio autorizado

O comando abaixo exige explicitamente a confirmação de produção no `.env`:

```powershell
# somente depois de revisar as cinco respostas
# ALLOW_PRODUCTION_SUBMIT=true
npm run submit
```

O script processa no máximo cinco respostas, aplica `DELAY_MS` entre elas e `PRE_SUBMIT_DELAY_MS` antes de cada clique em **Enviar**. Salva `qa-results.jsonl` e para imediatamente no primeiro erro. Não tenta contornar CAPTCHA, autenticação ou limites do Microsoft Forms.
