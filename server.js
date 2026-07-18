// Cobra Tech — servidor de cobrança extrajudicial (SIMULAÇÃO — nenhum pagamento é real)
// Sem dependências externas: roda com Node.js puro (node server.js)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const FEE_PERCENT = 10; // fee da Cobra Tech sobre valores recuperados

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
  { etapa: 'lembrete_whatsapp', dias: 0, descricao: 'WhatsApp (simulado): lembrete amigável de vencimento' },
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
function criarCobranca({ devedor, valor, vencimento, descricao }) {
  const c = {
    id: id(),
    token: token(),
    devedor, // { nome, telefone, email }
    valor: Number(valor),
    vencimento, // YYYY-MM-DD
    descricao: descricao || '',
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

function novoPix(cobranca, tipo, parcela, valor) {
  const txid = 'PIX-' + id().toUpperCase();
  const p = { txid, tipo, parcela, valor: Number(valor.toFixed(2)), status: 'pendente', criadoEm: new Date().toISOString() };
  cobranca.pagamentos.push(p);
  registrarEvento(cobranca.id, 'pix', `Pix (simulado) gerado: ${txid} — R$ ${p.valor.toFixed(2)}${parcela ? ` (parcela ${parcela})` : ''}`);
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
    const fee = p.valor * (FEE_PERCENT / 100);
    c.fee = Number((c.fee + fee).toFixed(2));
    registrarEvento(c.id, 'pagamento', `Webhook Pix (simulado): ${txid} confirmado — R$ ${p.valor.toFixed(2)} recebido, fee Cobra Tech (${FEE_PERCENT}%) R$ ${fee.toFixed(2)}`);
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
    const c = criarCobranca(b);
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
    return json(res, 200, { ...c, diasAtraso: diasAtraso(c), feePercent: FEE_PERCENT });
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
    return json(res, 200, novoPix(c, 'total', null, c.valor));
  }
  // Leads da landing page (validação com o público)
  if (p === '/api/leads' && req.method === 'POST') {
    const b = await corpo(req);
    if (!b.nome || !(b.whatsapp || b.email)) return json(res, 400, { erro: 'Informe nome e um contato (WhatsApp ou e-mail)' });
    const lead = { id: id(), nome: String(b.nome).slice(0,120), empresa: String(b.empresa||'').slice(0,120),
      whatsapp: String(b.whatsapp||'').slice(0,40), email: String(b.email||'').slice(0,120),
      volume: String(b.volume||'').slice(0,60), quando: new Date().toISOString() };
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
