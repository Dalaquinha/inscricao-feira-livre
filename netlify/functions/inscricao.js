// netlify/functions/inscricao.js
//
// Recebe a inscrição enviada pelo formulário, e:
// 1) valida o token do reCAPTCHA v3 junto ao Google
// 2) valida o CPF novamente no servidor (nunca confiar só no navegador)
// 3) grava a inscrição no Supabase e gera o protocolo (ex.: FEIRA-2026-004582)
// 4) envia:
//    - e-mail SIMPLES ao inscrito (protocolo, data/hora) — só para ele
//    - e-mail COMPLETO em HTML (todos os dados, formatado em linhas) para
//      feiralivreproeb@gmail.com, com cópia para incra.semmas@blumenau.sc.gov.br
//
// Variáveis de ambiente necessárias (Netlify > Site settings > Environment variables):
// SUPABASE_URL - URL do projeto Supabase
// SUPABASE_SERVICE_ROLE_KEY - service role key do Supabase (NUNCA a anon key)
// RECAPTCHA_SECRET_KEY - secret key do reCAPTCHA v3
// RECAPTCHA_MIN_SCORE - opcional, padrão 0.5
// GMAIL_USER - conta Gmail usada para enviar (feiralivreproeb@gmail.com)
// GMAIL_APP_PASSWORD - senha de app gerada na conta Gmail (não é a senha normal)
// EMAIL_REMETENTE - ex.: "Feira Livre de Blumenau <feiralivreproeb@gmail.com>"
// EMAIL_PREFEITURA_INTERNO - e-mail institucional da SEMMAS (recebe cópia do e-mail completo)

const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');

const RECAPTCHA_MIN_SCORE = parseFloat(process.env.RECAPTCHA_MIN_SCORE || '0.5');

function onlyDigits(s) {
  return (s || '').replace(/\D/g, '');
}

// mesma regra usada no front-end: dígitos verificadores + bloqueio de CPF fictício
function validarCPF(cpfSujo) {
  const cpf = onlyDigits(cpfSujo);
  if (cpf.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false;

  const calcDigito = (base, pesoInicial) => {
    let soma = 0;
    for (let i = 0; i < base.length; i++) soma += parseInt(base[i], 10) * (pesoInicial - i);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };

  const d1 = calcDigito(cpf.slice(0, 9), 10);
  if (d1 !== parseInt(cpf[9], 10)) return false;

  const d2 = calcDigito(cpf.slice(0, 10), 11);
  if (d2 !== parseInt(cpf[10], 10)) return false;

  return true;
}

async function verificarRecaptcha(token, ip) {
  if (!process.env.RECAPTCHA_SECRET_KEY) {
    console.warn('RECAPTCHA_SECRET_KEY não configurada — pulando verificação.');
    return { ok: true, score: null };
  }
  if (!token) return { ok: false, score: 0, motivo: 'token ausente' };

  const params = new URLSearchParams({
    secret: process.env.RECAPTCHA_SECRET_KEY,
    response: token,
    remoteip: ip || ''
  });

  const resp = await fetch('https://www.google.com/recaptcha/api/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  const json = await resp.json();

  if (!json.success) return { ok: false, score: 0, motivo: (json['error-codes'] || []).join(', ') };
  if (json.action && json.action !== 'inscricao_feira') return { ok: false, score: json.score, motivo: 'action divergente' };
  if (typeof json.score === 'number' && json.score < RECAPTCHA_MIN_SCORE) {
    return { ok: false, score: json.score, motivo: 'score abaixo do mínimo' };
  }
  return { ok: true, score: json.score };
}

function formatarDataHoraBR(date) {
  const data = date.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const hora = date.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return { data, hora };
}

async function gerarProtocolo(supabase, ano) {
  // Incrementa um contador atômico por ano (RPC no Postgres — ver supabase-schema.sql)
  const { data, error } = await supabase.rpc('gerar_protocolo', { p_ano: ano });
  if (error) throw error;
  return data; // ex.: "FEIRA-2026-004582"
}

function origemProdutosTexto(d) {
  if (d.produtor === 'produtor') return 'Produção própria';
  if (d.produtor === 'revenda') return `Revenda — adquirido de: ${d.fornecedores || '—'}`;
  return `Misto — própria: ${d.producaoPropria || '—'} | terceiros: ${d.producaoTerceiros || '—'}`;
}

// ---------- e-mail COMPLETO em HTML, formatado em linhas (sem logo por enquanto) ----------
function montarEmailCompletoHtml(d) {
  const linha = (label, valor) => `<p style="margin:0 0 6px;"><strong>${label}:</strong> ${valor || '—'}</p>`;
  const secao = (titulo) => `
    <hr style="border:none;border-top:1px solid #bbb;margin:16px 0 10px;">
    <p style="margin:0 0 8px;font-weight:bold;font-size:13px;letter-spacing:.02em;">${titulo}</p>
  `;

  return `
  <div style="font-family:Arial, sans-serif; font-size:14px; color:#222; max-width:640px;">
    <h2 style="margin:0 0 4px;">NOVA INSCRIÇÃO — FEIRA LIVRE MUNICIPAL</h2>
    <p style="margin:0 0 14px;color:#555;font-size:13px;">
      Protocolo: <strong>${d.protocolo}</strong> &nbsp;|&nbsp; Data: ${d.dataBR} às ${d.horaBR}
    </p>

    ${secao('DADOS PESSOAIS')}
    ${linha('Nome', d.nome)}
    ${linha('CPF', d.cpf)}
    ${linha('Data de Nascimento', d.nascimento)}
    ${linha('Telefone', d.telefone)}
    ${linha('Instagram', d.instagram)}
    ${linha('Endereço', d.enderecoTexto)}

    ${secao('FEIRA SOLICITADA')}
    ${linha('Local', d.local)}
    ${linha('Dias', d.diasTexto)}

    ${secao('PRODUTOS A SEREM COMERCIALIZADOS')}
    <p style="margin:0 0 6px;">${d.produtos}</p>

    ${secao('ORIGEM DOS PRODUTOS')}
    <p style="margin:0 0 6px;">${d.origemTexto}</p>

    ${secao('AUXILIARES NA BANCA')}
    ${linha('Quantidade', d.qtdAux)}
    ${linha('Nomes', d.nomesAux)}

    ${secao('DECLARAÇÃO')}
    <p style="margin:0 0 6px;">Declaro serem verdadeiras as informações prestadas e estar ciente das normas de funcionamento da Feira Livre Municipal, comprometendo-me a cumpri-las.</p>

    ${secao('USO DA SEMMAS')}
    <p style="margin:0 0 6px;">DEFERIDO POR: ______________________________________________</p>
    <p style="margin:0 0 6px;">EM ____/____/________&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;BANCA Nº: ________</p>
    <p style="margin:0 0 6px;">Início das atividades na feira: ____/____/________</p>

    <hr style="border:none;border-top:1px solid #bbb;margin:16px 0 10px;">
    <p style="margin:0;color:#666;font-size:11px;text-align:center;">
      Rua das Missões, 455 – Ponta Aguda – CEP 89051-000 – Blumenau – SC<br>
      Telefone/Fax: (47) 3381-6445 / 999520252 | incra.semmas@blumenau.sc.gov.br
    </p>
  </div>
  `;
}

// ---------- envio de e-mail via Gmail (nodemailer) ----------
let transporter; // reaproveita a conexão entre chamadas (dentro do mesmo container)

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD
      }
    });
  }
  return transporter;
}

async function enviarEmail({ to, subject, html }) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    console.warn('GMAIL_USER/GMAIL_APP_PASSWORD não configurados — e-mail não enviado para', to);
    return { enviado: false };
  }
  try {
    await getTransporter().sendMail({
      from: process.env.EMAIL_REMETENTE || `Feira Livre de Blumenau <${process.env.GMAIL_USER}>`,
      to,
      subject,
      html
    });
    return { enviado: true };
  } catch (e) {
    console.error('Falha ao enviar e-mail para', to, e.message);
    return { enviado: false };
  }
}

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ ok: false, erro: 'Método não permitido.' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, erro: 'JSON inválido.' }) };
  }

  const ip =
    event.headers['x-nf-client-connection-ip'] ||
    (event.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    'desconhecido';

  // ---------- 1) reCAPTCHA ----------
  try {
    const recaptcha = await verificarRecaptcha(body.recaptchaToken, ip);
    if (!recaptcha.ok) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, erro: 'Falha na verificação de segurança (reCAPTCHA). Tente novamente.' }) };
    }
  } catch (e) {
    console.error('Erro ao verificar reCAPTCHA:', e);
    return { statusCode: 502, body: JSON.stringify({ ok: false, erro: 'Não foi possível verificar o reCAPTCHA agora.' }) };
  }

  // ---------- 2) validações obrigatórias no servidor ----------
  const camposObrigatorios = ['nome', 'cpf', 'email', 'telefone', 'rua', 'numero', 'bairro', 'cep', 'cidade', 'produtos'];
  const faltando = camposObrigatorios.filter((c) => !body[c] || String(body[c]).trim() === '');
  if (faltando.length || !Array.isArray(body.dias) || body.dias.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, erro: 'Campos obrigatórios ausentes.' }) };
  }
  if (!body.aceite || !body.lgpd) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, erro: 'É necessário aceitar a declaração e o consentimento LGPD.' }) };
  }
  if (!validarCPF(body.cpf)) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, erro: 'CPF inválido.' }) };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, erro: 'E-mail inválido.' }) };
  }

  // ---------- 3) grava no Supabase e gera protocolo ----------
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const agora = new Date();
  const ano = agora.getFullYear();
  const { data: dataBR, hora: horaBR } = formatarDataHoraBR(agora);

  let protocolo;
  try {
    protocolo = await gerarProtocolo(supabase, ano);
  } catch (e) {
    console.error('Erro ao gerar protocolo:', e);
    return { statusCode: 500, body: JSON.stringify({ ok: false, erro: 'Não foi possível gerar o protocolo. Tente novamente.' }) };
  }

  const registro = {
    protocolo,
    local: body.local,
    dias: body.dias,
    nome: body.nome.trim(),
    cpf: onlyDigits(body.cpf),
    nascimento: body.nascimentoISO || null,
    email: body.email.trim(),
    telefone: body.telefone.trim(),
    instagram: body.instagram || null,
    endereco: {
      rua: body.rua.trim(),
      numero: body.numero.trim(),
      bairro: body.bairro.trim(),
      cep: onlyDigits(body.cep),
      cidade: body.cidade.trim(),
      uf: body.uf || 'SC'
    },
    produtos: body.produtos.trim(),
    origem_produtos: body.produtor,
    fornecedores: body.fornecedores || null,
    producao_propria: body.producaoPropria || null,
    producao_terceiros: body.producaoTerceiros || null,
    qtd_auxiliares: parseInt(body.qtdAux, 10) || 0,
    nomes_auxiliares: body.nomesAux || null,
    lgpd_aceite: !!body.lgpd,
    declaracao_aceite: !!body.aceite,
    ip,
    status: 'Recebida'
  };

  const { error: erroInsercao } = await supabase.from('inscricoes').insert(registro);
  if (erroInsercao) {
    console.error('Erro ao gravar inscrição:', erroInsercao);
    return { statusCode: 500, body: JSON.stringify({ ok: false, erro: 'Não foi possível gravar a inscrição. Tente novamente.' }) };
  }

  // ---------- 4) monta textos auxiliares e dispara os e-mails ----------
  const origemTexto = origemProdutosTexto(body);
  const diasTexto = body.dias.map((d) => (d === 'seg-qui' ? '2ª e 5ª-feira' : 'Sábados')).join(', ');
  const enderecoTexto = `${body.rua}, nº ${body.numero}, ${body.bairro}, CEP ${body.cep}, ${body.cidade}/${body.uf || 'SC'}`;

  // e-mail simples — só para o inscrito
  const emailInscrito = enviarEmail({
    to: body.email,
    subject: 'Confirmação de inscrição — Feira Livre de Blumenau',
    html: `
      <p>Olá, ${registro.nome}.</p>
      <p>Sua inscrição para banca na feira livre foi recebida.</p>
      <p><strong>Número do protocolo:</strong> ${protocolo}</p>
      <p><strong>Data:</strong> ${dataBR} às ${horaBR}</p>
      <p><strong>Local:</strong> ${body.local}<br>
      <strong>Dias:</strong> ${diasTexto}</p>
      <p>Acompanhe sua solicitação junto à Secretaria do Meio Ambiente e Sustentabilidade (SEMMAS) informando este número de protocolo.</p>
      <p>Guarde este e-mail para consulta futura.</p>
    `
  });

  // e-mail completo — feiralivreproeb@gmail.com + cópia para incra.semmas@blumenau.sc.gov.br
  const htmlCompleto = montarEmailCompletoHtml({
    protocolo, dataBR, horaBR,
    nome: registro.nome,
    cpf: registro.cpf,
    nascimento: body.nascimento || registro.nascimento,
    telefone: registro.telefone,
    instagram: registro.instagram,
    enderecoTexto,
    local: body.local,
    diasTexto,
    produtos: registro.produtos,
    origemTexto,
    qtdAux: registro.qtd_auxiliares,
    nomesAux: registro.nomes_auxiliares
  });

  const destinatariosInternos = [process.env.GMAIL_USER, process.env.EMAIL_PREFEITURA_INTERNO].filter(Boolean);

  const emailInterno = destinatariosInternos.length
    ? enviarEmail({
        to: destinatariosInternos,
        subject: `Nova inscrição recebida — ${protocolo}`,
        html: htmlCompleto
      })
    : Promise.resolve({ enviado: false });

  // não deixa falha de e-mail impedir a resposta de sucesso — a inscrição já está gravada
  await Promise.allSettled([emailInscrito, emailInterno]);

  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, protocolo, data: dataBR, hora: horaBR })
  };
};
