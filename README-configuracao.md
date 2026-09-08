# Configuração — Inscrição Feira Livre de Blumenau

Arquitetura: **HTML estático (Netlify)** + **Netlify Functions** (backend) +
**Supabase** (banco) + **Google reCAPTCHA v3** + **ViaCEP** + **Gmail via nodemailer** (e-mail).

## Arquivos deste pacote

```
index.html                            → formulário (sobe na raiz do site)
netlify/functions/inscricao.js        → function que valida, grava, gera protocolo e envia e-mails
netlify/functions/logo-semmas.base64.js → logo em base64, anexada (Content-ID) no e-mail interno
supabase-schema.sql                   → schema do banco (rodar uma vez no Supabase)
netlify.toml                          → configuração do Netlify
package.json                          → dependências (@supabase/supabase-js, nodemailer)
```

## 1) Supabase

1. Crie um projeto em https://supabase.com.
2. Vá em **SQL Editor** → cole o conteúdo de `supabase-schema.sql` → **Run**.
3. Em **Project Settings > API**, copie:
   - `Project URL` → variável `SUPABASE_URL`
   - `service_role` key (não a `anon`!) → variável `SUPABASE_SERVICE_ROLE_KEY`

A `service_role` key só é usada dentro da Netlify Function (nunca no navegador).

## 2) Google reCAPTCHA v3

1. Acesse https://www.google.com/recaptcha/admin e cadastre um site, tipo **reCAPTCHA v3**.
2. Copie a **Site Key** e cole em dois lugares do `inscricao_feira_livre.html`:
   - na tag `<script src="https://www.google.com/recaptcha/api.js?render=SUA_SITE_KEY_AQUI">`
   - na constante `const RECAPTCHA_SITE_KEY = 'SUA_SITE_KEY_AQUI';`
3. Copie a **Secret Key** → variável de ambiente `RECAPTCHA_SECRET_KEY`.
4. Opcional: `RECAPTCHA_MIN_SCORE` (padrão `0.5`) define a pontuação mínima aceita.

## 3) E-mail (Gmail via nodemailer)

1. Use (ou crie) uma conta Gmail dedicada para o envio, ex.: `feiralivreproeb@gmail.com`.
2. Ative a verificação em duas etapas nessa conta e gere uma **senha de app**
   (Conta Google > Segurança > Senhas de app) — não é a senha normal de login.
3. Defina as variáveis de ambiente:
   - `GMAIL_USER` → o e-mail da conta (ex.: `feiralivreproeb@gmail.com`)
   - `GMAIL_APP_PASSWORD` → a senha de app gerada
   - `EMAIL_REMETENTE` → ex.: `Feira Livre de Blumenau <feiralivreproeb@gmail.com>`
   - `EMAIL_PREFEITURA_INTERNO` → e-mail institucional que recebe cópia do e-mail completo (ex.: `incra.semmas@blumenau.sc.gov.br`)

A logo do cabeçalho do e-mail interno vai embutida como anexo (Content-ID), a partir de
`netlify/functions/logo-semmas.base64.js` — não depende de nenhuma URL pública, então
continua aparecendo mesmo que o domínio do site mude.

> Pode trocar o Gmail por outro provedor (Resend, SendGrid, Postmark etc.) editando só a
> função `enviarEmail()` e o `getTransporter()` em `netlify/functions/inscricao.js` —
> o restante do fluxo não muda.

## 4) Variáveis de ambiente no Netlify

Em **Site settings > Environment variables**, cadastre:

| Variável | Descrição |
|---|---|
| `SUPABASE_URL` | URL do projeto Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | service role key do Supabase |
| `RECAPTCHA_SECRET_KEY` | secret key do reCAPTCHA v3 |
| `RECAPTCHA_MIN_SCORE` | opcional, padrão `0.5` |
| `GMAIL_USER` | conta Gmail usada para enviar (ex.: `feiralivreproeb@gmail.com`) |
| `GMAIL_APP_PASSWORD` | senha de app gerada na conta Gmail (não é a senha normal) |
| `EMAIL_REMETENTE` | remetente das confirmações |
| `EMAIL_PREFEITURA_INTERNO` | e-mail interno que recebe o aviso de nova inscrição |

## 5) Deploy

- Suba a pasta inteira (incluindo `netlify/`, `netlify.toml` e `package.json`) para um
  repositório Git conectado ao Netlify, ou arraste a pasta no **Netlify Drop**
  (nesse caso configure as functions manualmente em Site settings).
- O Netlify instala `@supabase/supabase-js` e `nodemailer` automaticamente a partir do
  `package.json` — sem esse arquivo, a function falha ao ser publicada e o formulário
  não envia (fica "carregando" para sempre ou retorna erro).

## Fluxo implementado

1. Pessoa preenche o formulário.
2. **CPF**: validado no navegador (feedback imediato) e de novo no servidor —
   confere quantidade de dígitos, dígitos verificadores e bloqueia CPFs fictícios
   (`111.111.111-11` etc.). O mesmo CPF pode gerar mais de uma inscrição (protocolos diferentes),
   como no exemplo do fluxo original.
3. **CEP**: ao sair do campo, consulta a ViaCEP e preenche rua/bairro/cidade/UF automaticamente.
4. **LGPD**: caixa obrigatória e separada da declaração de veracidade; sem marcar, não envia.
5. **reCAPTCHA v3**: roda em segundo plano (sem desafio visual); token é verificado no servidor,
   que rejeita pontuações baixas (prováveis robôs).
6. **Gravação**: a Netlify Function grava a inscrição no Supabase com IP, data/hora e status `Recebida`.
7. **Protocolo**: gerado atomicamente no Postgres (`FEIRA-2026-004582`), evitando duplicidade
   mesmo com envios simultâneos.
8. **E-mails**: confirmação ao inscrito (com o protocolo) e aviso interno à Prefeitura,
   disparados pelo servidor após a gravação.
9. O PDF do requerimento continua sendo gerado no navegador (como já funcionava),
   agora com o número de protocolo impresso no cabeçalho.

## O que falta decidir/ajustar depois

- **Deferimento/indeferimento**: o campo `status` já existe na tabela; um painel administrativo
  para trocar de `Recebida` para `Deferida`/`Indeferida` não foi incluído aqui.
- **Duplicidade de CPF**: hoje o sistema permite múltiplas inscrições para o mesmo CPF
  (replicando o exemplo do fluxo original). Se quiser bloquear reinscrição no mesmo ano,
  dá pra adicionar uma constraint única em `(cpf, extract(year from criado_em))`.
