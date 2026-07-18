// Cobra Tech — servidor de cobrança extrajudicial (SIMULAÇÃO — nenhum pagamento é real)
// Sem dependências externas: roda com Node.js puro (node server.js)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const FEE_PERCENT = 10;        // success fee sobre valores recuperados (títulos +15 dias vencidos)
const FEE_CARENCIA_DIAS = 15;  // até 15 dias de atraso, a recuperação é coberta pela assinatura (sem fee)
const ALCADA_DESCONTO = 10;    // % máximo de desconto à vista que o portal pode ofertar (alçada do credor)

// ---------- Persistência ----------
let db = { cobrancas: [], eventos: [], leads: [] };

function carregar() {
  try {
    db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    db = { cobrancas: [], eventos: [], leads: [] };
    salvar();
  }
  if (!db.leads) db.leads = [];
}
function salvar() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

function id() { return crypto.randomBytes(6).toString('hex'); }
function token() { return crypto.randomBytes(12).toString('hex'); }

function registrarEvento(cobrancaId, tipo, descricao) {
  db.eventos.push({ id: id(), cobrancaId, tipo, descricao, quando: new Date().toISOString() });
  salvar();
}

// ---------- Régua de cobrança (simulada) ----------
// dias = dias de atraso a partir do vencimento
const REGUA = [
  { etapa: 'pre_vencimento', dias: -3, descricao: 'WhatsApp (simulado): prevenção — "sua fatura vence em 3 dias" com link de pagamento' },
  { etapa: 'lembrete_whatsapp', dias: 0, descricao: 'WhatsApp (simulado): lembrete amigável no dia do vencimento' },
  { etapa: 'email_atraso', dias: 2, descricao: 'E-mail (simulado): aviso de atraso com link do portal' },
  { etapa: 'whatsapp_proposta', dias: 5, descricao: 'WhatsApp (simulado): proposta de parcelamento pelo portal' },
  { etapa: 'sms_urgencia', dias: 10, descricao: 'SMS (simulado): último aviso antes de negativação' },
  { etapa: 'aviso_negativacao', dias: 15, descricao: 'E-mail (simulado): aviso formal de possível negativação (Serasa)' }
];

function diasAtraso(cobranca) {
  const venc = new Date(cobranca.vencimento + 'T00:00:00');
  return Math.floor((Date.now() - venc.getTime()) / 86400000);
}

function rodarRegua() {
  let mudou = false;
  for (const c of db.cobrancas) {
    if (c.status !== 'aberta') continue;
    const atraso = diasAtraso(c);
    for (const etapa of REGUA) {
      if (atraso >= etapa.dias && !c.reguaExecutada.includes(etapa.etapa)) {
        c.reguaExecutada.push(etapa.etapa);
        registrarEvento(c.id, 'regua', `[Régua • dia ${etapa.dias}] ${etapa.descricao} → ${c.devedor.nome} (${c.devedor.telefone})`);
        mudou = true;
      }
    }
  }
  if (mudou) salvar();
}
setInterval(rodarRegua, 30000); // roda sozinha a cada 30 segundos

// ---------- Regras de negócio ----------
function criarCobranca({ devedor, valor, vencimento, descricao, pix }) {
  const c = {
    id: id(),
    token: token(),
    devedor, // { nome, telefone, email }
    valor: Number(valor),
    vencimento, // YYYY-MM-DD
    descricao: descricao || '',
    // Modelo 1: Pix direto na conta do credor. Sem chave = modo demonstração.
    pix: (pix && pix.chave) ? {
      chave: String(pix.chave).trim().slice(0, 77),
      nome: String(pix.nome || devedor.nome || 'RECEBEDOR').trim().slice(0, 25),
      cidade: String(pix.cidade || 'SAO PAULO').trim().slice(0, 15)
    } : null,
    status: 'aberta', // aberta | acordo | paga
    reguaExecutada: [],
    pagamentos: [], // { txid, tipo, parcela, valor, status: 'pendente'|'pago', pagoEm }
    acordo: null, // { parcelas: n, valorParcela }
    fee: 0,
    criadaEm: new Date().toISOString()
  };
  db.cobrancas.push(c);
  registrarEvento(c.id, 'criacao', `Cobrança criada: ${devedor.nome}, R$ ${Number(valor).toFixed(2)}, vencimento ${vencimento}`);
  salvar();
  return c;
}

// ---------- BR Code (Pix copia-e-cola oficial, EMV/BCB) ----------
function crc16(str) {
  let crc = 0xFFFF;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}
function emv(id, valor) { return id + String(valor.length).padStart(2, '0') + valor; }
function limparTexto(s) { return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 .-]/g, ' ').toUpperCase().trim(); }
function gerarBrcode(pix, valor, txid) {
  const conta = emv('00', 'BR.GOV.BCB.PIX') + emv('01', pix.chave);
  let payload = emv('00', '01') + emv('26', conta) + emv('52', '0000') + emv('53', '986') +
    emv('54', valor.toFixed(2)) + emv('58', 'BR') + emv('59', limparTexto(pix.nome) || 'RECEBEDOR') +
    emv('60', limparTexto(pix.cidade) || 'SAO PAULO') + emv('62', emv('05', txid.replace(/[^A-Za-z0-9]/g, '').slice(0, 25)));
  payload += '6304';
  return payload + crc16(payload);
}

function novoPix(cobranca, tipo, parcela, valor) {
  const txid = 'PIX' + id().toUpperCase();
  const real = !!(cobranca.pix && cobranca.pix.chave);
  const p = { txid, tipo, parcela, valor: Number(valor.toFixed(2)), status: 'pendente', modo: real ? 'real' : 'demo', criadoEm: new Date().toISOString() };
  if (real) p.brcode = gerarBrcode(cobranca.pix, p.valor, txid);
  cobranca.pagamentos.push(p);
  registrarEvento(cobranca.id, 'pix', `Pix ${real ? 'REAL (direto na conta do credor)' : '(simulado)'} gerado: ${txid} — R$ ${p.valor.toFixed(2)}${parcela ? ` (parcela ${parcela})` : ''}`);
  salvar();
  return p;
}

function fecharAcordo(cobranca, nParcelas) {
  const n = Math.max(1, Math.min(6, Number(nParcelas)));
  const valorParcela = cobranca.valor / n;
  cobranca.acordo = { parcelas: n, valorParcela: Number(valorParcela.toFixed(2)) };
  cobranca.status = 'acordo';
  for (let i = 1; i <= n; i++) novoPix(cobranca, 'parcela', i, valorParcela);
  registrarEvento(cobranca.id, 'acordo', `Acordo fechado pelo devedor no portal: ${n}x de R$ ${valorParcela.toFixed(2)} (sem intervenção humana)`);
  salvar();
  return cobranca;
}

// Webhook do Pix (simulado): confirma um pagamento e dá baixa
function confirmarPix(txid) {
  for (const c of db.cobrancas) {
    const p = c.pagamentos.find(p => p.txid === txid);
    if (!p) continue;
    if (p.status === 'pago') return { erro: 'Pagamento já confirmado' };
    p.status = 'pago';
    p.pagoEm = new Date().toISOString();
    // Success fee só sobre títulos vencidos há mais de FEE_CARENCIA_DIAS (modelo híbrido do plano de negócio)
    const atrasoNoPgto = Math.floor((Date.now() - new Date(c.vencimento + 'T00:00:00').getTime()) / 86400000);
    const cobraFee = atrasoNoPgto > FEE_CARENCIA_DIAS;
    const fee = cobraFee ? p.valor * (FEE_PERCENT / 100) : 0;
    c.fee = Number((c.fee + fee).toFixed(2));
    registrarEvento(c.id, 'pagamento', `Webhook Pix (simulado): ${txid} confirmado — R$ ${p.valor.toFixed(2)} recebido. ` +
      (cobraFee ? `Success fee (${FEE_PERCENT}%): R$ ${fee.toFixed(2)}` : `Sem success fee (título com ${atrasoNoPgto} dias de atraso, dentro da carência de ${FEE_CARENCIA_DIAS} dias — coberto pela assinatura)`));
    const pendentes = c.pagamentos.filter(x => x.status !== 'pago');
    if (pendentes.length === 0 || p.tipo === 'total') {
      c.status = 'paga';
      registrarEvento(c.id, 'baixa', 'Cobrança quitada — baixa automática');
    }
    salvar();
    return { ok: true, cobranca: c };
  }
  return { erro: 'txid não encontrado' };
}

// ---------- HTTP ----------
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function corpo(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  // API
  if (p === '/api/cobrancas' && req.method === 'GET') {
    return json(res, 200, db.cobrancas.map(c => ({ ...c, diasAtraso: diasAtraso(c) })));
  }
  if (p === '/api/cobrancas' && req.method === 'POST') {
    const b = await corpo(req);
    if (!b.devedor || !b.devedor.nome || !b.valor || !b.vencimento) return json(res, 400, { erro: 'Campos obrigatórios: devedor.nome, valor, vencimento' });
    const c = criarCobranca(b); // b.pix = { chave, nome, cidade } opcional → modo real
    rodarRegua(); // executa imediatamente etapas já devidas
    return json(res, 201, c);
  }
  if (p === '/api/eventos' && req.method === 'GET') {
    const cid = url.searchParams.get('cobrancaId');
    const evs = cid ? db.eventos.filter(e => e.cobrancaId === cid) : db.eventos;
    return json(res, 200, evs.slice().reverse());
  }
  const mPortal = p.match(/^\/api\/portal\/([a-f0-9]+)$/);
  if (mPortal && req.method === 'GET') {
    const c = db.cobrancas.find(c => c.token === mPortal[1]);
    if (!c) return json(res, 404, { erro: 'Cobrança não encontrada' });
    return json(res, 200, { ...c, diasAtraso: diasAtraso(c), feePercent: FEE_PERCENT, descontoAvista: ALCADA_DESCONTO });
  }
  const mAcordo = p.match(/^\/api\/portal\/([a-f0-9]+)\/acordo$/);
  if (mAcordo && req.method === 'POST') {
    const c = db.cobrancas.find(c => c.token === mAcordo[1]);
    if (!c) return json(res, 404, { erro: 'Cobrança não encontrada' });
    if (c.status !== 'aberta') return json(res, 400, { erro: 'Cobrança não está aberta' });
    const b = await corpo(req);
    return json(res, 200, fecharAcordo(c, b.parcelas || 1));
  }
  const mPagar = p.match(/^\/api\/portal\/([a-f0-9]+)\/pagar$/);
  if (mPagar && req.method === 'POST') {
    const c = db.cobrancas.find(c => c.token === mPagar[1]);
    if (!c) return json(res, 404, { erro: 'Cobrança não encontrada' });
    if (c.status !== 'aberta') return json(res, 400, { erro: 'Cobrança não está aberta' });
    const b = await corpo(req);
    // Desconto à vista dentro da alçada definida pelo credor (só para títulos em atraso)
    if (b.desconto && diasAtraso(c) > 0) {
      const valorDesc = c.valor * (1 - ALCADA_DESCONTO / 100);
      registrarEvento(c.id, 'acordo', `Devedor aceitou quitação à vista com ${ALCADA_DESCONTO}% de desconto (alçada do credor) — R$ ${valorDesc.toFixed(2)}`);
      return json(res, 200, novoPix(c, 'total', null, valorDesc));
    }
    return json(res, 200, novoPix(c, 'total', null, c.valor));
  }
  // Leads da landing page (validação com o público)
  if (p === '/api/leads' && req.method === 'POST') {
    const b = await corpo(req);
    if (!b.nome || !(b.whatsapp || b.email)) return json(res, 400, { erro: 'Informe nome e um contato (WhatsApp ou e-mail)' });
    const lead = { id: id(), nome: String(b.nome).slice(0,120), empresa: String(b.empresa||'').slice(0,120),
      whatsapp: String(b.whatsapp||'').slice(0,40), email: String(b.email||'').slice(0,120),
      segmento: String(b.segmento||'').slice(0,60), volume: String(b.volume||'').slice(0,60), quando: new Date().toISOString() };
    db.leads.push(lead);
    salvar();
    return json(res, 201, { ok: true });
  }
  if (p === '/api/leads' && req.method === 'GET') {
    return json(res, 200, db.leads.slice().reverse());
  }
  if (p === '/api/webhook/pix' && req.method === 'POST') {
    const b = await corpo(req);
    const r = confirmarPix(b.txid);
    return json(res, r.erro ? 400 : 200, r);
  }
  // Modelo 1: devedor informa que pagou → credor confirma no painel
  const mInformar = p.match(/^\/api\/portal\/([a-f0-9]+)\/informei$/);
  if (mInformar && req.method === 'POST') {
    const c = db.cobrancas.find(c => c.token === mInformar[1]);
    if (!c) return json(res, 404, { erro: 'Cobrança não encontrada' });
    const b = await corpo(req);
    const pg = c.pagamentos.find(x => x.txid === b.txid);
    if (!pg) return json(res, 404, { erro: 'Pagamento não encontrado' });
    if (pg.status === 'pendente') {
      pg.status = 'informado';
      pg.informadoEm = new Date().toISOString();
      registrarEvento(c.id, 'pix', `Devedor informou pagamento de R$ ${pg.valor.toFixed(2)} (${pg.txid}) — aguardando o credor confirmar o recebimento na conta`);
      salvar();
    }
    return json(res, 200, { ok: true });
  }
  const mConfirmar = p.match(/^\/api\/cobrancas\/([a-f0-9]+)\/confirmar$/);
  if (mConfirmar && req.method === 'POST') {
    const c = db.cobrancas.find(c => c.id === mConfirmar[1]);
    if (!c) return json(res, 404, { erro: 'Cobrança não encontrada' });
    const b = await corpo(req);
    const r = confirmarPix(b.txid);
    return json(res, r.erro ? 400 : 200, r);
  }

  // Link curto do portal: /portal/<token> → portal.html?t=<token>
  const mLink = p.match(/^\/portal\/([a-f0-9]+)$/);
  if (mLink) {
    res.writeHead(302, { Location: `/portal.html?t=${mLink[1]}` });
    return res.end();
  }

  // Estáticos
  let file = p === '/' ? '/index.html' : p;
  const fp = path.join(PUBLIC_DIR, path.normalize(file).replace(/^(\.\.[\/\\])+/, ''));
  if (fp.startsWith(PUBLIC_DIR) && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    return res.end(fs.readFileSync(fp));
  }
  json(res, 404, { erro: 'Não encontrado' });
});

carregar();
rodarRegua();
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Cobra Tech rodando em http://127.0.0.1:${PORT}/painel.html`);
  console.log('Lembrete: todos os pagamentos são SIMULADOS — nada é cobrado de verdade.');
});
