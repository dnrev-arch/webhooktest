const express = require('express');
const axios = require('axios');
const app = express();

// Armazenamento em memória
let pendingPixOrders = new Map();
let systemLogs = [];
let leadResponses = new Map();
let leadPurchases = new Map();
let allEvents = []; // Novo: histórico de todos os eventos

const LOG_RETENTION_TIME = 60 * 60 * 1000; // 1 hora
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://n8n.flowzap.fun/webhook/207400a6-1290-4153-b033-c658e657d717';
const N8N_WHATSAPP_URL = process.env.N8N_WHATSAPP_URL || 'https://n8n.flowzap.fun/webhook/c0d9ac75-a0db-426c-ad25-09f5d0644c6f';
const PIX_TIMEOUT = 7 * 60 * 1000; // 7 minutos

app.use(express.json());
app.use(express.static('public')); // Para servir arquivos estáticos

// Função para normalizar telefones
function normalizePhone(phone) {
    if (!phone) return '';
    
    let normalized = phone.toString().replace(/\D/g, '');
    
    const ddds_brasileiros = [
        '11','12','13','14','15','16','17','18','19',
        '21','22','24','27','28',
        '31','32','33','34','35','37','38',
        '41','42','43','44','45','46',
        '47','48','49',
        '51','53','54','55',
        '61','62','63','64','65','66','67',
        '68','69',
        '71','73','74','75','77','79',
        '81','82','83','84','85','86','87','88','89',
        '91','92','93','94','95','96','97','98','99'
    ];
    
    // Correção DDI 57 → 55
    if (normalized.startsWith('57') && normalized.length === 13) {
        const possivelDDD = normalized.substring(2, 4);
        if (ddds_brasileiros.includes(possivelDDD)) {
            normalized = '55' + normalized.substring(2);
        }
    }
    
    // Adicionar DDI 55 se necessário
    if (normalized.length === 13 && normalized.startsWith('55')) {
        return normalized;
    }
    
    if (normalized.length === 11) {
        const ddd = normalized.substring(0, 2);
        if (ddds_brasileiros.includes(ddd)) {
            normalized = '55' + normalized;
        }
    } else if (normalized.length === 10) {
        const ddd = normalized.substring(0, 2);
        if (ddds_brasileiros.includes(ddd)) {
            const numero = normalized.substring(2);
            normalized = '55' + ddd + '9' + numero;
        }
    }
    
    return normalized;
}

// Função para adicionar logs
function addLog(type, message, data = null) {
    const logEntry = {
        timestamp: new Date().toISOString(),
        type: type,
        message: message,
        data: data
    };
    
    systemLogs.push(logEntry);
    console.log('[' + logEntry.timestamp + '] ' + type.toUpperCase() + ': ' + message);
    
    const oneHourAgo = Date.now() - LOG_RETENTION_TIME;
    systemLogs = systemLogs.filter(log => new Date(log.timestamp).getTime() > oneHourAgo);
}

// Função para adicionar evento ao histórico
function addEvent(type, status, data) {
    const event = {
        id: Date.now() + '_' + Math.random().toString(36).substr(2, 9),
        timestamp: new Date().toISOString(),
        type: type,
        status: status,
        cliente: data.customerName || data.customer?.full_name || 'N/A',
        telefone: data.phone || data.customerPhone || '',
        pedido: data.orderCode || data.order_code || data.code || '',
        produto: data.product || data.produto || '',
        valor: data.amount || data.sale_amount || 0,
        instancia: data.instancia || '',
        enviadoN8N: data.enviadoN8N || false,
        mensagem: data.message || '',
        pixUrl: data.pixUrl || data.billet_url || '',
        pixCode: data.pixCode || data.billet_number || ''
    };
    
    allEvents.unshift(event); // Adiciona no início
    
    // Limitar a 1000 eventos
    if (allEvents.length > 1000) {
        allEvents = allEvents.slice(0, 1000);
    }
    
    return event;
}

// Limpeza automática
function cleanOldData() {
    const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
    
    // Limpar respostas antigas
    for (let [phone, data] of leadResponses.entries()) {
        if (data.timestamp < oneDayAgo) {
            leadResponses.delete(phone);
        }
    }
    
    // Limpar compras antigas
    for (let [phone, data] of leadPurchases.entries()) {
        if (data.timestamp < oneDayAgo) {
            leadPurchases.delete(phone);
        }
    }
    
    // Limpar eventos antigos
    allEvents = allEvents.filter(event => 
        new Date(event.timestamp).getTime() > oneDayAgo
    );
    
    addLog('info', 'Limpeza automática executada');
}

setInterval(cleanOldData, 60 * 60 * 1000);

// WEBHOOK PERFECT PAY
app.post('/webhook/perfect', async (req, res) => {
    try {
        console.log('\n💰 === WEBHOOK PERFECT PAY ===');
        
        const data = req.body;
        const orderCode = data.code || '';
        const status = data.sale_status_enum_key || '';
        const customerName = data.customer?.full_name || 'N/A';
        const amount = data.sale_amount || 0;
        
        // Extrair telefone
        const phoneExtension = data.customer?.phone_extension || '';
        const phoneAreaCode = data.customer?.phone_area_code || '';
        const phoneNumber = data.customer?.phone_number || '';
        const rawCustomerPhone = phoneExtension + phoneAreaCode + phoneNumber;
        const customerPhone = normalizePhone(rawCustomerPhone);
        
        // Extrair dados PIX
        const pixUrl = data.billet_url || '';
        const pixCode = data.billet_number || '';
        
        // Adicionar ao histórico de eventos
        const eventData = {
            customerName: customerName,
            phone: customerPhone,
            orderCode: orderCode,
            amount: amount,
            pixUrl: pixUrl,
            pixCode: pixCode,
            product: data.product?.name || data.plan?.name || '',
            enviadoN8N: false
        };
        
        const event = addEvent('PIX_GERADO', status.toUpperCase(), eventData);
        
        addLog('webhook_received', `Perfect Pay - ${orderCode} | ${status} | ${customerPhone}`);
        
        // Salvar dados do lead
        if (customerPhone && customerPhone.length >= 10) {
            leadPurchases.set(customerPhone, {
                timestamp: Date.now(),
                originalData: {
                    ...data,
                    billet_url: pixUrl,
                    billet_number: pixCode
                },
                orderCode: orderCode,
                customerName: customerName,
                amount: amount,
                phone: customerPhone,
                pixUrl: pixUrl,
                pixCode: pixCode,
                status: status,
                eventId: event.id
            });
        }
        
        // Processar status
        if (status === 'approved') {
            if (pendingPixOrders.has(orderCode)) {
                clearTimeout(pendingPixOrders.get(orderCode).timeout);
                pendingPixOrders.delete(orderCode);
            }
            
            // Atualizar evento
            const eventIndex = allEvents.findIndex(e => e.pedido === orderCode);
            if (eventIndex !== -1) {
                allEvents[eventIndex].status = 'APROVADO';
                allEvents[eventIndex].type = 'VENDA_APROVADA';
            }
            
        } else if (status === 'pending') {
            // Configurar timeout
            if (pendingPixOrders.has(orderCode)) {
                clearTimeout(pendingPixOrders.get(orderCode).timeout);
            }
            
            const timeout = setTimeout(async () => {
                addLog('timeout', `TIMEOUT PIX - ${orderCode}`);
                pendingPixOrders.delete(orderCode);
                
                // Atualizar evento
                const eventIndex = allEvents.findIndex(e => e.pedido === orderCode);
                if (eventIndex !== -1) {
                    allEvents[eventIndex].status = 'TIMEOUT';
                    allEvents[eventIndex].type = 'PIX_TIMEOUT';
                }
                
                await sendToN8N(data, 'pix_timeout');
            }, PIX_TIMEOUT);
            
            pendingPixOrders.set(orderCode, {
                data: data,
                timeout: timeout,
                timestamp: new Date(),
                customer_name: customerName,
                amount: amount,
                customer_phone: customerPhone
            });
        }
        
        // Enviar para N8N
        const sendResult = await sendToN8N(data, status || 'webhook_received');
        
        // Atualizar status de envio
        if (sendResult.success) {
            event.enviadoN8N = true;
            const eventIndex = allEvents.findIndex(e => e.id === event.id);
            if (eventIndex !== -1) {
                allEvents[eventIndex].enviadoN8N = true;
            }
        }
        
        res.status(200).json({ 
            success: true, 
            order_code: orderCode,
            status: status,
            phone: customerPhone,
            event_id: event.id
        });
        
    } catch (error) {
        console.error('❌ Erro no Perfect Pay:', error);
        addLog('error', `ERRO webhook Perfect: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

// WEBHOOK WHATSAPP
app.post('/webhook/whatsapp-response', async (req, res) => {
    try {
        console.log('\n📱 === WEBHOOK WHATSAPP ===');
        
        // Anti-duplicata
        const requestId = req.body.key?.id || JSON.stringify(req.body).substring(0, 100);
        const duplicateKey = 'wh_dup_' + requestId;
        
        if (leadResponses.has(duplicateKey)) {
            return res.status(200).json({ success: true, duplicated: true });
        }
        
        leadResponses.set(duplicateKey, { timestamp: Date.now() });
        
        const data = req.body;
        
        // Extrair telefone e mensagem
        let phone = null;
        let message = null;
        
        const phoneAttempts = [
            data.key?.remoteJid,
            data.data?.key?.remoteJid,
            data.data?.messages?.[0]?.key?.remoteJid,
            data.instance?.remoteJid,
            data.phone,
            data.from,
            data.number
        ];
        
        for (const attempt of phoneAttempts) {
            if (attempt && typeof attempt === 'string' && attempt.includes('@')) {
                phone = attempt.replace('@s.whatsapp.net', '').replace('@c.us', '');
                break;
            }
        }
        
        const messageAttempts = [
            data.message?.conversation,
            data.data?.message?.conversation,
            data.data?.messages?.[0]?.message?.conversation,
            data.data?.messages?.[0]?.message?.extendedTextMessage?.text,
            data.text,
            data.body,
            data.content
        ];
        
        for (const attempt of messageAttempts) {
            if (attempt && typeof attempt === 'string' && attempt.trim()) {
                message = attempt.trim();
                break;
            }
        }
        
        if (phone && message) {
            const normalizedPhone = normalizePhone(phone);
            
            // Registrar resposta
            leadResponses.set(normalizedPhone, {
                timestamp: Date.now(),
                message: message,
                phone: normalizedPhone,
                full_data: data
            });
            
            // Buscar dados do PIX
            let pixDataSalvo = leadPurchases.get(normalizedPhone);
            
            // Adicionar evento de resposta
            const eventData = {
                phone: normalizedPhone,
                message: message,
                customerName: pixDataSalvo?.customerName || 'Cliente',
                orderCode: pixDataSalvo?.orderCode || '',
                amount: pixDataSalvo?.amount || 0,
                enviadoN8N: false
            };
            
            const event = addEvent('RESPOSTA_CLIENTE', 'ATIVA', eventData);
            
            addLog('info', `RESPOSTA - Tel: ${normalizedPhone}`);
            
            // Preparar payload
            const continuationPayload = {
                lead_interaction: {
                    responded: true,
                    response_message: message,
                    response_time: new Date().toISOString(),
                    phone: normalizedPhone
                },
                event_type: 'lead_active_continuation',
                processed_at: new Date().toISOString(),
                system_info: {
                    source: 'perfect-webhook-system-v3',
                    version: '3.0'
                },
                billet_url: pixDataSalvo?.pixUrl || pixDataSalvo?.originalData?.billet_url || '',
                billet_number: pixDataSalvo?.pixCode || pixDataSalvo?.originalData?.billet_number || '',
                sale_amount: pixDataSalvo?.amount || 0,
                sale_status_enum_key: pixDataSalvo?.status || 'pending',
                customer: pixDataSalvo?.originalData?.customer || {},
                order_code: pixDataSalvo?.orderCode || '',
                code: pixDataSalvo?.orderCode || ''
            };
            
            // Enviar para N8N
            const sendResult = await sendToN8N(continuationPayload, 'lead_active_continuation', true);
            
            if (sendResult.success) {
                event.enviadoN8N = true;
                const eventIndex = allEvents.findIndex(e => e.id === event.id);
                if (eventIndex !== -1) {
                    allEvents[eventIndex].enviadoN8N = true;
                }
                addLog('success', `FLUXO CONTINUADO - ${normalizedPhone}`);
            }
        }
        
        res.status(200).json({ 
            success: true, 
            message: 'Webhook processado',
            phone: phone ? normalizePhone(phone) : null
        });
        
    } catch (error) {
        console.error('❌ Erro no webhook WhatsApp:', error);
        addLog('error', `ERRO WhatsApp: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Função sendToN8N
async function sendToN8N(data, eventType, useWhatsAppWebhook = false) {
    try {
        const webhookUrl = useWhatsAppWebhook ? N8N_WHATSAPP_URL : N8N_WEBHOOK_URL;
        
        const payload = {
            ...data,
            event_type: eventType,
            processed_at: new Date().toISOString(),
            system_info: {
                source: 'perfect-webhook-system-v3',
                version: '3.0'
            }
        };
        
        const response = await axios.post(webhookUrl, payload, {
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Perfect-Webhook-System-v3'
            },
            timeout: 10000
        });
        
        addLog('webhook_sent', `Enviado N8N - ${eventType}`);
        return { success: true, status: response.status };
        
    } catch (error) {
        const errorMessage = error.response ? 
            `HTTP ${error.response.status}` : error.message;
        
        addLog('error', `Erro N8N - ${errorMessage}`);
        return { success: false, error: errorMessage };
    }
}

// === ENDPOINTS DA API ===

// Dashboard completo
app.get('/api/dashboard', (req, res) => {
    const now = Date.now();
    const last24h = now - (24 * 60 * 60 * 1000);
    
    // Estatísticas
    const stats = {
        pixPendentes: pendingPixOrders.size,
        conversasAtivas: 0,
        vendasAprovadas24h: 0,
        pixTimeout24h: 0,
        totalEventos: allEvents.length,
        totalRespostas: 0,
        totalLeads: leadPurchases.size
    };
    
    // Calcular estatísticas das últimas 24h
    allEvents.forEach(event => {
        const eventTime = new Date(event.timestamp).getTime();
        if (eventTime > last24h) {
            if (event.type === 'VENDA_APROVADA') stats.vendasAprovadas24h++;
            if (event.type === 'PIX_TIMEOUT') stats.pixTimeout24h++;
            if (event.type === 'RESPOSTA_CLIENTE') stats.totalRespostas++;
            if (event.status === 'ATIVA') stats.conversasAtivas++;
        }
    });
    
    res.json({
        timestamp: new Date().toISOString(),
        stats: stats,
        systemInfo: {
            version: '3.0',
            uptime: process.uptime(),
            memoryUsage: process.memoryUsage(),
            n8nUrl: N8N_WEBHOOK_URL,
            pixTimeout: PIX_TIMEOUT / 60000
        }
    });
});

// Listar todos os eventos com filtros
app.get('/api/events', (req, res) => {
    const { type, status, search, limit = 100, offset = 0 } = req.query;
    
    let filteredEvents = [...allEvents];
    
    // Aplicar filtros
    if (type && type !== 'Todos') {
        filteredEvents = filteredEvents.filter(e => e.type === type);
    }
    
    if (status && status !== 'Todos') {
        filteredEvents = filteredEvents.filter(e => e.status === status);
    }
    
    if (search) {
        const searchLower = search.toLowerCase();
        filteredEvents = filteredEvents.filter(e => 
            e.cliente.toLowerCase().includes(searchLower) ||
            e.telefone.includes(search) ||
            e.pedido.toLowerCase().includes(searchLower)
        );
    }
    
    // Paginação
    const total = filteredEvents.length;
    const events = filteredEvents.slice(Number(offset), Number(offset) + Number(limit));
    
    res.json({
        events: events,
        total: total,
        limit: Number(limit),
        offset: Number(offset)
    });
});

// Detalhes de um lead específico
app.get('/api/lead/:phone', (req, res) => {
    const phone = normalizePhone(req.params.phone);
    
    const leadData = leadPurchases.get(phone);
    const responses = leadResponses.get(phone);
    
    // Buscar todos os eventos deste lead
    const leadEvents = allEvents.filter(e => 
        e.telefone === phone || normalizePhone(e.telefone) === phone
    );
    
    res.json({
        phone: phone,
        data: leadData || null,
        responses: responses || null,
        events: leadEvents,
        hasActiveConversation: responses && responses.timestamp > (Date.now() - 30 * 60 * 1000)
    });
});

// Estatísticas detalhadas
app.get('/api/stats/detailed', (req, res) => {
    const now = Date.now();
    const periods = {
        '1h': now - (60 * 60 * 1000),
        '6h': now - (6 * 60 * 60 * 1000),
        '24h': now - (24 * 60 * 60 * 1000),
        '7d': now - (7 * 24 * 60 * 60 * 1000)
    };
    
    const stats = {};
    
    Object.keys(periods).forEach(period => {
        const since = periods[period];
        stats[period] = {
            pix_gerados: 0,
            vendas_aprovadas: 0,
            pix_timeout: 0,
            respostas: 0,
            conversas_ativas: 0
        };
        
        allEvents.forEach(event => {
            const eventTime = new Date(event.timestamp).getTime();
            if (eventTime > since) {
                if (event.type === 'PIX_GERADO') stats[period].pix_gerados++;
                if (event.type === 'VENDA_APROVADA') stats[period].vendas_aprovadas++;
                if (event.type === 'PIX_TIMEOUT') stats[period].pix_timeout++;
                if (event.type === 'RESPOSTA_CLIENTE') stats[period].respostas++;
                if (event.status === 'ATIVA') stats[period].conversas_ativas++;
            }
        });
    });
    
    res.json(stats);
});

// Exportar dados
app.get('/api/export', (req, res) => {
    const { format = 'json', type = 'all' } = req.query;
    
    let data = {};
    
    if (type === 'all' || type === 'events') {
        data.events = allEvents;
    }
    
    if (type === 'all' || type === 'leads') {
        data.leads = Array.from(leadPurchases.entries()).map(([phone, lead]) => ({
            phone,
            ...lead
        }));
    }
    
    if (type === 'all' || type === 'logs') {
        data.logs = systemLogs;
    }
    
    if (format === 'csv') {
        // Converter para CSV simples
        const csv = [];
        csv.push('Timestamp,Type,Status,Cliente,Telefone,Pedido,Valor');
        
        allEvents.forEach(e => {
            csv.push(`${e.timestamp},${e.type},${e.status},${e.cliente},${e.telefone},${e.pedido},${e.valor}`);
        });
        
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="export.csv"');
        res.send(csv.join('\n'));
    } else {
        res.json(data);
    }
});

// Logs do sistema
app.get('/api/logs', (req, res) => {
    const { type, limit = 100 } = req.query;
    
    let logs = [...systemLogs];
    
    if (type) {
        logs = logs.filter(log => log.type === type);
    }
    
    res.json(logs.slice(-limit));
});

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'online',
        version: '3.0',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Interface web principal
app.get('/', (req, res) => {
    const htmlContent = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<title>🧠 Cérebro de Atendimento</title>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
* {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
}

body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    min-height: 100vh;
}

.header {
    background: white;
    padding: 20px 30px;
    box-shadow: 0 2px 10px rgba(0,0,0,0.1);
    display: flex;
    justify-content: space-between;
    align-items: center;
}

.header h1 {
    color: #333;
    font-size: 24px;
    display: flex;
    align-items: center;
    gap: 10px;
}

.header .subtitle {
    color: #666;
    font-size: 14px;
    font-weight: normal;
}

.header-info {
    display: flex;
    gap: 30px;
    font-size: 14px;
    color: #666;
}

.header-info .info-item {
    display: flex;
    flex-direction: column;
}

.header-info .info-label {
    font-size: 12px;
    color: #999;
}

.header-info .info-value {
    font-weight: 600;
    color: #333;
}

.container {
    padding: 30px;
    max-width: 1400px;
    margin: 0 auto;
}

.stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
    gap: 20px;
    margin-bottom: 30px;
}

.stat-card {
    background: white;
    border-radius: 15px;
    padding: 25px;
    box-shadow: 0 5px 15px rgba(0,0,0,0.1);
    position: relative;
    overflow: hidden;
}

.stat-card::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    width: 5px;
    height: 100%;
}

.stat-card.orange::before { background: #f59e0b; }
.stat-card.blue::before { background: #3b82f6; }
.stat-card.green::before { background: #10b981; }
.stat-card.red::before { background: #ef4444; }
.stat-card.purple::before { background: #8b5cf6; }

.stat-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 15px;
}

.stat-icon {
    width: 40px;
    height: 40px;
    border-radius: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 20px;
}

.stat-card.orange .stat-icon { background: #fef3c7; color: #f59e0b; }
.stat-card.blue .stat-icon { background: #dbeafe; color: #3b82f6; }
.stat-card.green .stat-icon { background: #d1fae5; color: #10b981; }
.stat-card.red .stat-icon { background: #fee2e2; color: #ef4444; }
.stat-card.purple .stat-icon { background: #ede9fe; color: #8b5cf6; }

.stat-label {
    color: #6b7280;
    font-size: 14px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
}

.stat-value {
    font-size: 32px;
    font-weight: 700;
    color: #1f2937;
    margin-bottom: 5px;
}

.stat-subtitle {
    color: #9ca3af;
    font-size: 12px;
}

.main-content {
    background: white;
    border-radius: 15px;
    box-shadow: 0 5px 15px rgba(0,0,0,0.1);
    overflow: hidden;
}

.tabs {
    display: flex;
    background: #f9fafb;
    border-bottom: 1px solid #e5e7eb;
}

.tab {
    padding: 15px 30px;
    cursor: pointer;
    background: transparent;
    border: none;
    font-size: 14px;
    font-weight: 500;
    color: #6b7280;
    display: flex;
    align-items: center;
    gap: 8px;
    transition: all 0.3s ease;
}

.tab:hover {
    background: #f3f4f6;
}

.tab.active {
    color: #667eea;
    background: white;
    position: relative;
}

.tab.active::after {
    content: '';
    position: absolute;
    bottom: -1px;
    left: 0;
    right: 0;
    height: 2px;
    background: #667eea;
}

.tab-content {
    padding: 20px;
}

.filters {
    display: flex;
    gap: 15px;
    margin-bottom: 20px;
    flex-wrap: wrap;
}

.filter-group {
    display: flex;
    flex-direction: column;
    gap: 5px;
}

.filter-label {
    font-size: 12px;
    color: #6b7280;
    text-transform: uppercase;
    letter-spacing: 0.5px;
}

select, input[type="text"] {
    padding: 8px 12px;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    font-size: 14px;
    background: white;
}

input[type="text"] {
    min-width: 250px;
}

.btn {
    padding: 8px 16px;
    border-radius: 8px;
    border: none;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.3s ease;
    display: inline-flex;
    align-items: center;
    gap: 5px;
}

.btn-primary {
    background: #667eea;
    color: white;
}

.btn-primary:hover {
    background: #5a67d8;
}

.btn-secondary {
    background: #f3f4f6;
    color: #4b5563;
}

.btn-secondary:hover {
    background: #e5e7eb;
}

.btn-success {
    background: #10b981;
    color: white;
}

.btn-danger {
    background: #ef4444;
    color: white;
}

.table-container {
    overflow-x: auto;
}

table {
    width: 100%;
    border-collapse: collapse;
}

thead {
    background: #f9fafb;
}

th {
    padding: 12px;
    text-align: left;
    font-size: 12px;
    font-weight: 600;
    color: #6b7280;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    border-bottom: 1px solid #e5e7eb;
}

td {
    padding: 12px;
    font-size: 14px;
    color: #1f2937;
    border-bottom: 1px solid #f3f4f6;
}

tr:hover {
    background: #f9fafb;
}

.badge {
    display: inline-block;
    padding: 4px 10px;
    border-radius: 20px;
    font-size: 12px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.5px;
}

.badge-success {
    background: #d1fae5;
    color: #065f46;
}

.badge-warning {
    background: #fef3c7;
    color: #92400e;
}

.badge-danger {
    background: #fee2e2;
    color: #991b1b;
}

.badge-info {
    background: #dbeafe;
    color: #1e40af;
}

.badge-purple {
    background: #ede9fe;
    color: #5b21b6;
}

.tag {
    display: inline-block;
    padding: 2px 8px;
    background: #fbbf24;
    color: #78350f;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
    margin-left: 5px;
}

.action-buttons {
    display: flex;
    gap: 10px;
    margin-bottom: 20px;
}

.empty-state {
    text-align: center;
    padding: 60px 20px;
    color: #9ca3af;
}

.empty-state-icon {
    font-size: 48px;
    margin-bottom: 20px;
    opacity: 0.5;
}

.empty-state-title {
    font-size: 18px;
    font-weight: 600;
    color: #6b7280;
    margin-bottom: 10px;
}

.loading {
    text-align: center;
    padding: 40px;
    color: #6b7280;
}

.spinner {
    border: 3px solid #f3f4f6;
    border-top: 3px solid #667eea;
    border-radius: 50%;
    width: 40px;
    height: 40px;
    animation: spin 1s linear infinite;
    margin: 0 auto 20px;
}

@keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
}

.chart-container {
    padding: 20px;
    background: white;
    border-radius: 15px;
    margin-top: 20px;
}

#n8nBadge {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    display: inline-block;
    margin-left: 5px;
}

#n8nBadge.online { background: #10b981; }
#n8nBadge.offline { background: #ef4444; }
</style>
</head>
<body>

<div class="header">
    <div>
        <h1>
            🧠 Cérebro de Atendimento
            <span class="subtitle">Sistema Evolution - Gestão Inteligente de Leads</span>
        </h1>
    </div>
    <div class="header-info">
        <div class="info-item">
            <span class="info-label">N8N Webhook URL:</span>
            <span class="info-value">
                ${N8N_WEBHOOK_URL.replace('https://', '').substring(0, 30)}...
                <span id="n8nBadge" class="online"></span>
            </span>
        </div>
        <div class="info-item">
            <span class="info-label">Retenção de Dados:</span>
            <span class="info-value">24 horas</span>
        </div>
        <div class="info-item">
            <span class="info-label">Timeout PIX:</span>
            <span class="info-value">${PIX_TIMEOUT / 60000} minutos</span>
        </div>
        <div class="info-item">
            <span class="info-label">Horário:</span>
            <span class="info-value" id="currentTime">--:--:--</span>
        </div>
    </div>
</div>

<div class="container">
    <div class="stats-grid">
        <div class="stat-card orange">
            <div class="stat-header">
                <div class="stat-label">PIX Pendentes</div>
                <div class="stat-icon">⏳</div>
            </div>
            <div class="stat-value" id="stat-pix-pendentes">0</div>
            <div class="stat-subtitle">Aguardando pagamento</div>
        </div>
        
        <div class="stat-card blue">
            <div class="stat-header">
                <div class="stat-label">Conversas Ativas</div>
                <div class="stat-icon">💬</div>
            </div>
            <div class="stat-value" id="stat-conversas-ativas">0</div>
            <div class="stat-subtitle">Últimos 30 minutos</div>
        </div>
        
        <div class="stat-card green">
            <div class="stat-header">
                <div class="stat-label">Vendas Aprovadas</div>
                <div class="stat-icon">✅</div>
            </div>
            <div class="stat-value" id="stat-vendas-aprovadas">0</div>
            <div class="stat-subtitle">Últimas 24h</div>
        </div>
        
        <div class="stat-card red">
            <div class="stat-header">
                <div class="stat-label">PIX Timeout</div>
                <div class="stat-icon">⏰</div>
            </div>
            <div class="stat-value" id="stat-pix-timeout">0</div>
            <div class="stat-subtitle">Últimas 24h</div>
        </div>
        
        <div class="stat-card purple">
            <div class="stat-header">
                <div class="stat-label">Total de Leads</div>
                <div class="stat-icon">👥</div>
            </div>
            <div class="stat-value" id="stat-total-leads">0</div>
            <div class="stat-subtitle">Cadastrados no sistema</div>
        </div>
    </div>
    
    <div class="main-content">
        <div class="tabs">
            <button class="tab active" onclick="switchTab('events')">
                📋 Eventos <span id="events-count">(0)</span>
            </button>
            <button class="tab" onclick="switchTab('pending')">
                🕐 PIX Pendentes
            </button>
            <button class="tab" onclick="switchTab('conversations')">
                💬 Conversas Ativas
            </button>
            <button class="tab" onclick="switchTab('logs')">
                📊 Logs do Sistema
            </button>
            <button class="tab" onclick="switchTab('stats')">
                📈 Estatísticas
            </button>
        </div>
        
        <div class="tab-content" id="tab-events">
            <div class="filters">
                <div class="filter-group">
                    <label class="filter-label">Tipo de Evento</label>
                    <select id="filter-type" onchange="filterEvents()">
                        <option>Todos</option>
                        <option>PIX_GERADO</option>
                        <option>VENDA_APROVADA</option>
                        <option>PIX_TIMEOUT</option>
                        <option>RESPOSTA_CLIENTE</option>
                    </select>
                </div>
                <div class="filter-group">
                    <label class="filter-label">Status</label>
                    <select id="filter-status" onchange="filterEvents()">
                        <option>Todos</option>
                        <option>PENDING</option>
                        <option>APPROVED</option>
                        <option>TIMEOUT</option>
                        <option>ATIVA</option>
                    </select>
                </div>
                <div class="filter-group">
                    <label class="filter-label">Buscar</label>
                    <input type="text" id="filter-search" placeholder="Nome, telefone, pedido..." onkeyup="filterEvents()">
                </div>
            </div>
            
            <div class="action-buttons">
                <button class="btn btn-primary" onclick="refreshData()">
                    🔄 Atualizar Dados
                </button>
                <button class="btn btn-secondary" onclick="exportData('csv')">
                    📥 Exportar CSV
                </button>
                <button class="btn btn-secondary" onclick="exportData('json')">
                    📥 Exportar JSON
                </button>
                <button class="btn btn-danger" onclick="clearFilters()">
                    🗑️ Limpar Filtros
                </button>
            </div>
            
            <div class="table-container">
                <table id="events-table">
                    <thead>
                        <tr>
                            <th>DATA/HORA</th>
                            <th>TIPO</th>
                            <th>STATUS</th>
                            <th>CLIENTE</th>
                            <th>TELEFONE</th>
                            <th>PEDIDO</th>
                            <th>PRODUTO</th>
                            <th>VALOR</th>
                            <th>INSTÂNCIA</th>
                            <th>N8N</th>
                        </tr>
                    </thead>
                    <tbody id="events-tbody">
                        <tr>
                            <td colspan="10" class="loading">
                                <div class="spinner"></div>
                                Carregando dados...
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>
        
        <div class="tab-content" id="tab-pending" style="display:none;">
            <div class="empty-state">
                <div class="empty-state-icon">⏳</div>
                <div class="empty-state-title">PIX Pendentes</div>
                <p>Visualize todos os PIX aguardando pagamento</p>
            </div>
        </div>
        
        <div class="tab-content" id="tab-conversations" style="display:none;">
            <div class="empty-state">
                <div class="empty-state-icon">💬</div>
                <div class="empty-state-title">Conversas Ativas</div>
                <p>Monitore as conversas em andamento</p>
            </div>
        </div>
        
        <div class="tab-content" id="tab-logs" style="display:none;">
            <div class="table-container">
                <table id="logs-table">
                    <thead>
                        <tr>
                            <th>TIMESTAMP</th>
                            <th>TIPO</th>
                            <th>MENSAGEM</th>
                        </tr>
                    </thead>
                    <tbody id="logs-tbody">
                        <tr>
                            <td colspan="3" class="loading">Carregando logs...</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>
        
        <div class="tab-content" id="tab-stats" style="display:none;">
            <div class="chart-container">
                <h3>📊 Estatísticas por Período</h3>
                <div id="stats-periods"></div>
            </div>
        </div>
    </div>
</div>

<script>
// Variáveis globais
let currentTab = 'events';
let eventsData = [];
let dashboardData = {};

// Atualizar relógio
function updateTime() {
    const now = new Date();
    document.getElementById('currentTime').textContent = 
        now.toLocaleString('pt-BR', { 
            day: '2-digit',
            month: '2-digit', 
            year: 'numeric',
            hour: '2-digit', 
            minute: '2-digit',
            second: '2-digit'
        });
}
setInterval(updateTime, 1000);
updateTime();

// Trocar abas
function switchTab(tab) {
    currentTab = tab;
    
    // Atualizar visual das abas
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    event.target.classList.add('active');
    
    // Esconder todos os conteúdos
    document.querySelectorAll('.tab-content').forEach(content => {
        content.style.display = 'none';
    });
    
    // Mostrar conteúdo selecionado
    document.getElementById('tab-' + tab).style.display = 'block';
    
    // Carregar dados específicos da aba
    if (tab === 'logs') {
        loadLogs();
    } else if (tab === 'stats') {
        loadStats();
    } else if (tab === 'pending') {
        loadPending();
    } else if (tab === 'conversations') {
        loadConversations();
    }
}

// Carregar dashboard
async function loadDashboard() {
    try {
        const response = await fetch('/api/dashboard');
        dashboardData = await response.json();
        
        // Atualizar estatísticas
        document.getElementById('stat-pix-pendentes').textContent = dashboardData.stats.pixPendentes;
        document.getElementById('stat-conversas-ativas').textContent = dashboardData.stats.conversasAtivas;
        document.getElementById('stat-vendas-aprovadas').textContent = dashboardData.stats.vendasAprovadas24h;
        document.getElementById('stat-pix-timeout').textContent = dashboardData.stats.pixTimeout24h;
        document.getElementById('stat-total-leads').textContent = dashboardData.stats.totalLeads;
        
    } catch (error) {
        console.error('Erro ao carregar dashboard:', error);
    }
}

// Carregar eventos
async function loadEvents() {
    try {
        const type = document.getElementById('filter-type').value;
        const status = document.getElementById('filter-status').value;
        const search = document.getElementById('filter-search').value;
        
        const params = new URLSearchParams({
            type: type,
            status: status,
            search: search,
            limit: 100
        });
        
        const response = await fetch('/api/events?' + params);
        const data = await response.json();
        
        eventsData = data.events;
        document.getElementById('events-count').textContent = '(' + data.total + ')';
        
        renderEvents();
        
    } catch (error) {
        console.error('Erro ao carregar eventos:', error);
    }
}

// Renderizar eventos na tabela
function renderEvents() {
    const tbody = document.getElementById('events-tbody');
    
    if (eventsData.length === 0) {
        tbody.innerHTML = '<tr><td colspan="10" class="empty-state">Nenhum evento encontrado</td></tr>';
        return;
    }
    
    tbody.innerHTML = eventsData.map(event => {
        const date = new Date(event.timestamp);
        const dateStr = date.toLocaleDateString('pt-BR');
        const timeStr = date.toLocaleTimeString('pt-BR');
        
        // Badge do tipo
        let typeBadge = '';
        if (event.type === 'PIX_GERADO') typeBadge = '<span class="badge badge-info">PIX GERADO</span>';
        else if (event.type === 'VENDA_APROVADA') typeBadge = '<span class="badge badge-success">VENDA APROVADA</span>';
        else if (event.type === 'PIX_TIMEOUT') typeBadge = '<span class="badge badge-danger">TIMEOUT</span>';
        else if (event.type === 'RESPOSTA_CLIENTE') typeBadge = '<span class="badge badge-purple">RESPOSTA</span>';
        else typeBadge = '<span class="badge">' + event.type + '</span>';
        
        // Badge do status
        let statusBadge = '';
        if (event.status === 'APPROVED') statusBadge = '<span class="badge badge-success">APROVADO</span>';
        else if (event.status === 'PENDING') statusBadge = '<span class="badge badge-warning">PENDENTE</span>';
        else if (event.status === 'TIMEOUT') statusBadge = '<span class="badge badge-danger">TIMEOUT</span>';
        else if (event.status === 'ATIVA') statusBadge = '<span class="badge badge-info">ATIVA</span>';
        else statusBadge = '<span class="badge">' + event.status + '</span>';
        
        // Tag da instância
        const instanciaTag = event.instancia ? '<span class="tag">' + event.instancia + '</span>' : '';
        
        // N8N status
        const n8nStatus = event.enviadoN8N ? 
            '✅' : '❌';
        
        // Formatar valor
        const valor = event.valor ? 'R$ ' + Number(event.valor).toFixed(2).replace('.', ',') : '-';
        
        return '<tr>' +
            '<td>' + dateStr + ' ' + timeStr + '</td>' +
            '<td>' + typeBadge + '</td>' +
            '<td>' + statusBadge + '</td>' +
            '<td>' + (event.cliente || '-') + '</td>' +
            '<td>' + (event.telefone || '-') + '</td>' +
            '<td>' + (event.pedido || '-') + '</td>' +
            '<td>' + (event.produto || '-') + '</td>' +
            '<td>' + valor + '</td>' +
            '<td>' + instanciaTag + '</td>' +
            '<td>' + n8nStatus + '</td>' +
            '</tr>';
    }).join('');
}

// Filtrar eventos
function filterEvents() {
    loadEvents();
}

// Limpar filtros
function clearFilters() {
    document.getElementById('filter-type').value = 'Todos';
    document.getElementById('filter-status').value = 'Todos';
    document.getElementById('filter-search').value = '';
    loadEvents();
}

// Carregar logs
async function loadLogs() {
    try {
        const response = await fetch('/api/logs?limit=50');
        const logs = await response.json();
        
        const tbody = document.getElementById('logs-tbody');
        
        if (logs.length === 0) {
            tbody.innerHTML = '<tr><td colspan="3" class="empty-state">Nenhum log disponível</td></tr>';
            return;
        }
        
        tbody.innerHTML = logs.reverse().map(log => {
            let typeBadge = '';
            if (log.type === 'error') typeBadge = '<span class="badge badge-danger">ERRO</span>';
            else if (log.type === 'success') typeBadge = '<span class="badge badge-success">SUCESSO</span>';
            else if (log.type === 'info') typeBadge = '<span class="badge badge-info">INFO</span>';
            else typeBadge = '<span class="badge">' + log.type + '</span>';
            
            return '<tr>' +
                '<td>' + new Date(log.timestamp).toLocaleString('pt-BR') + '</td>' +
                '<td>' + typeBadge + '</td>' +
                '<td>' + log.message + '</td>' +
                '</tr>';
        }).join('');
        
    } catch (error) {
        console.error('Erro ao carregar logs:', error);
    }
}

// Carregar estatísticas
async function loadStats() {
    try {
        const response = await fetch('/api/stats/detailed');
        const stats = await response.json();
        
        const container = document.getElementById('stats-periods');
        
        container.innerHTML = Object.keys(stats).map(period => {
            const data = stats[period];
            
            return '<div style="margin: 20px 0; padding: 20px; background: #f9fafb; border-radius: 10px;">' +
                '<h4 style="margin-bottom: 15px;">Período: ' + period + '</h4>' +
                '<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px;">' +
                '<div><strong>PIX Gerados:</strong> ' + data.pix_gerados + '</div>' +
                '<div><strong>Vendas Aprovadas:</strong> ' + data.vendas_aprovadas + '</div>' +
                '<div><strong>PIX Timeout:</strong> ' + data.pix_timeout + '</div>' +
                '<div><strong>Respostas:</strong> ' + data.respostas + '</div>' +
                '<div><strong>Conversas Ativas:</strong> ' + data.conversas_ativas + '</div>' +
                '</div>' +
                '</div>';
        }).join('');
        
    } catch (error) {
        console.error('Erro ao carregar estatísticas:', error);
    }
}

// Carregar PIX pendentes
async function loadPending() {
    const events = eventsData.filter(e => e.status === 'PENDING');
    
    const content = document.getElementById('tab-pending');
    
    if (events.length === 0) {
        content.innerHTML = '<div class="empty-state">' +
            '<div class="empty-state-icon">⏳</div>' +
            '<div class="empty-state-title">Nenhum PIX Pendente</div>' +
            '<p>Todos os PIX foram processados</p>' +
            '</div>';
        return;
    }
    
    content.innerHTML = '<div class="table-container">' +
        '<table>' +
        '<thead><tr>' +
        '<th>CLIENTE</th><th>TELEFONE</th><th>PEDIDO</th><th>VALOR</th><th>TEMPO</th>' +
        '</tr></thead>' +
        '<tbody>' +
        events.map(e => {
            const tempo = Math.round((Date.now() - new Date(e.timestamp).getTime()) / 60000);
            return '<tr>' +
                '<td>' + e.cliente + '</td>' +
                '<td>' + e.telefone + '</td>' +
                '<td>' + e.pedido + '</td>' +
                '<td>R$ ' + Number(e.valor).toFixed(2).replace('.', ',') + '</td>' +
                '<td>' + tempo + ' min</td>' +
                '</tr>';
        }).join('') +
        '</tbody></table></div>';
}

// Carregar conversas ativas
async function loadConversations() {
    const events = eventsData.filter(e => e.type === 'RESPOSTA_CLIENTE' && e.status === 'ATIVA');
    
    const content = document.getElementById('tab-conversations');
    
    if (events.length === 0) {
        content.innerHTML = '<div class="empty-state">' +
            '<div class="empty-state-icon">💬</div>' +
            '<div class="empty-state-title">Nenhuma Conversa Ativa</div>' +
            '<p>Não há conversas em andamento no momento</p>' +
            '</div>';
        return;
    }
    
    content.innerHTML = '<div class="table-container">' +
        '<table>' +
        '<thead><tr>' +
        '<th>CLIENTE</th><th>TELEFONE</th><th>ÚLTIMA MENSAGEM</th><th>TEMPO</th>' +
        '</tr></thead>' +
        '<tbody>' +
        events.map(e => {
            const tempo = Math.round((Date.now() - new Date(e.timestamp).getTime()) / 60000);
            return '<tr>' +
                '<td>' + e.cliente + '</td>' +
                '<td>' + e.telefone + '</td>' +
                '<td>' + (e.mensagem || 'Mensagem recebida').substring(0, 50) + '...</td>' +
                '<td>' + tempo + ' min atrás</td>' +
                '</tr>';
        }).join('') +
        '</tbody></table></div>';
}

// Exportar dados
async function exportData(format) {
    try {
        const response = await fetch('/api/export?format=' + format);
        
        if (format === 'csv') {
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'export_' + new Date().getTime() + '.csv';
            a.click();
        } else {
            const data = await response.json();
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'export_' + new Date().getTime() + '.json';
            a.click();
        }
        
    } catch (error) {
        console.error('Erro ao exportar:', error);
    }
}

// Atualizar dados
function refreshData() {
    loadDashboard();
    loadEvents();
}

// Inicializar
refreshData();

// Auto-refresh a cada 10 segundos
setInterval(refreshData, 10000);
</script>

</body>
</html>`;
    
    res.send(htmlContent);
});

// Inicialização
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    addLog('info', `Sistema v3.0 iniciado na porta ${PORT}`);
    console.log('🚀 Servidor v3.0 - Dashboard Completo');
    console.log('📊 Interface: http://localhost:' + PORT);
    console.log('💰 Webhook Perfect Pay: /webhook/perfect');
    console.log('📱 Webhook WhatsApp: /webhook/whatsapp-response');
    console.log('🔍 API Dashboard: /api/dashboard');
    console.log('📋 API Eventos: /api/events');
    console.log('📈 API Estatísticas: /api/stats/detailed');
    console.log('✅ Funcionalidades:');
    console.log('  - Dashboard completo com estatísticas');
    console.log('  - Tabela de eventos com filtros');
    console.log('  - Exportação CSV/JSON');
    console.log('  - Logs do sistema');
    console.log('  - Monitoramento em tempo real');
    console.log('  - Interface profissional');
});
