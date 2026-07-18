# Cobra Tech — Sistema de Cobrança Extrajudicial (Simulação)

⚠️ **Todos os pagamentos são simulados.** O "Pix" exibido é de mentira — nenhum valor é cobrado de ninguém. Este projeto roda 100% de graça no seu computador.

## Como abrir (3 passos)

Pré-requisito: Node.js instalado (gratuito em https://nodejs.org).

1. Abra o Terminal na pasta `CObratech`
2. Digite: `npm start`
3. Abra no navegador: http://localhost:3000/painel.html

(Não precisa de `npm install` — o projeto não tem dependências externas.)

## O que já funciona de verdade

- **Dados persistem** em `data.json` — fechar e abrir não perde nada
- **Link único de portal** por cobrança (botão "Copiar link" no painel)
- **Régua de cobrança automática**: roda sozinha no servidor a cada 30 segundos e executa as etapas conforme os dias de atraso (lembrete → e-mail → proposta → SMS → aviso de negativação), tudo registrado na linha do tempo
- **Autonegociação**: o devedor fecha acordo parcelado (2x a 6x) no portal sem ninguém intervir
- **Webhook do Pix (simulado)**: confirma o pagamento, dá baixa automática e calcula seu **fee de 10%**

## Dica para demonstrar

Crie uma cobrança com vencimento no passado (ex.: 10 dias atrás) — a régua dispara na hora as etapas já devidas. Depois abra o link do portal como se fosse o devedor e feche um acordo.

## Régua padrão (dias de atraso)

| Dia | Etapa |
|-----|-------|
| 0   | WhatsApp: lembrete amigável |
| 2   | E-mail: aviso de atraso com link do portal |
| 5   | WhatsApp: proposta de parcelamento |
| 10  | SMS: último aviso |
| 15  | E-mail: aviso formal de possível negativação |

Edite a constante `REGUA` em `server.js` para mudar etapas e prazos.

## Próximos passos (para virar produção)

1. **Pix real**: integrar um gateway como Asaas ou Mercado Pago (geram QR Code e chamam seu webhook de verdade)
2. **Mensagens reais**: WhatsApp Business API (ex.: via Twilio ou Z-API) e e-mail (ex.: Resend)
3. **Hospedagem**: subir em um serviço como Railway ou Render para os links do portal funcionarem fora do seu computador
4. Banco de dados real (Postgres) quando o volume crescer
5. Conformidade: seguir o Código de Defesa do Consumidor (art. 42 e 71 — sem constrangimento ou ameaça) e LGPD no tratamento dos dados dos devedores
