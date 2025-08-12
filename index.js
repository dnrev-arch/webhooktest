const express = require('express');
const axios = require('axios');
const app = express();

// Armazenamento em memória
let pendingPixOrders = new Map();
let systemLogs = [];
let leadResponses = new Map();
let leadPurchases = new Map();

const LOG_RETENTION_TIME = 60 * 60 * 1000; // 1 hora
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://n8n.flowzap.fun/webhook/207400a6-1290-4153-b033-c658e657d717';
const PIX_TIMEOUT = 7 * 60 * 1000; // 7 minutos

app.use(express.json());

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

// Limpeza automática de leads antigos
function cleanOldLeads() {
    const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
    
    for (let [phone, data] of leadResponses.entries()) {
        if (data.timestamp < oneDayAgo) {
            leadResponses.delete(phone);
        }
    }
    
    for (let [phone, data] of leadPurchases.entries()) {
        if (data.timestamp < oneDayAgo) {
            leadPurchases.delete(phone);
        }
    }
    
    addLog('info', 'Limpeza automática - Leads antigos removidos');
}

setInterval(cleanOldLeads, 60 * 60 * 1000);

// NOVO: Endpoint para WhatsApp respostas
app.post('/webhook/whatsapp-response', async (req, res) => {
    try {
        const data = req.body;
        
        const phone = data.key?.remoteJid?.replace('@s.whatsapp.net', '') || 
                     data.data?.key?.remoteJid?.replace('@s.whatsapp.net', '') ||
                     data.phone || data.from || data.number;
                     
        const message = data.data?.message?.conversation || 
                       data.data?.message?.extendedTextMessage?.text ||
                       data.message || data.text || data.body || '';
        
        if (phone && message && !phone.includes('@g.us')) {
            leadResponses.set(phone, {
                timestamp: Date.now(),
                message: message,
                phone: phone,
                full_data: data
            });
            
            addLog('info', 'LEAD RESPONDEU - Tel: ' + phone + ' | Msg: ' + message.substring(0, 50) + '...', {
                phone: phone,
                message: message
            });
            
            const hasPurchase = leadPurchases.has(phone);
            
            if (hasPurchase) {
                const purchaseData = leadPurchases.get(phone);
                
                addLog('success', 'LEAD ATIVO - Tel: ' + phone + ' | Pedido: ' + purchaseData.orderCode);
                
                const continuationPayload = {
                    ...purchaseData.originalData,
                    lead_interaction: {
                        responded: true,
                        response_message: message,
                        response_time: new Date().toISOString(),
                        phone: phone,
                        customer_name: purchaseData.customerName
                    },
                    event_type: 'lead_active_continuation',
                    processed_at: new Date().toISOString(),
                    system_info: {
                        source: 'perfect-webhook-system-v2',
                        version: '2.1'
                    }
                };
                
                const sendResult = await sendToN8N(continuationPayload, 'lead_active_continuation');
                
                if (sendResult.success) {
                    addLog('success', 'FLUXO CONTINUADO - Lead: ' + phone + ' | Pedido: ' + purchaseData.orderCode);
                    leadPurchases.delete(phone);
                    leadResponses.delete(phone);
                } else {
                    addLog('error', 'ERRO ao continuar fluxo - Lead: ' + phone);
                }
            } else {
                addLog('info', 'Resposta registrada (sem compra) - Tel: ' + phone);
            }
        }
        
        res.status(200).json({ 
            success: true, 
            message: 'Resposta WhatsApp processada',
            phone: phone
        });
        
    } catch (error) {
        addLog('error', 'ERRO resposta WhatsApp: ' + error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Webhook Perfect Pay
app.post('/webhook/perfect', async (req, res) => {
    try {
        const data = req.body;
        const orderCode = data.code;
        const status = data.sale_status_enum_key;
        const customerName = data.customer?.full_name || 'N/A';
        const amount = data.sale_amount || 0;
        
        const customerPhone = (data.customer?.phone_extension_number || '') + 
                             (data.customer?.phone_area_code || '') + 
                             (data.customer?.phone_number || '');
        
        addLog('webhook_received', 'Webhook - Pedido: ' + orderCode + ' | Status: ' + status + ' | Tel: ' + customerPhone, {
            order_code: orderCode,
            status: status,
            phone: customerPhone
        });
        
        if (status === 'approved') {
            addLog('info', 'VENDA APROVADA - ' + orderCode);
            
            if (pendingPixOrders.has(orderCode)) {
                clearTimeout(pendingPixOrders.get(orderCode).timeout);
                pendingPixOrders.delete(orderCode);
            }
            
            if (customerPhone && customerPhone.length >= 10) {
                leadPurchases.set(customerPhone, {
                    timestamp: Date.now(),
                    originalData: data,
                    orderCode: orderCode,
                    customerName: customerName,
                    amount: amount,
                    phone: customerPhone
                });
                
                addLog('info', 'COMPRA REGISTRADA - Tel: ' + customerPhone + ' | Pedido: ' + orderCode);
            }
            
            const sendResult = await sendToN8N(data, 'approved');
            
            if (sendResult.success) {
                addLog('success', 'VENDA APROVADA enviada - ' + orderCode);
            } else {
                addLog('error', 'ERRO enviar VENDA APROVADA - ' + orderCode);
            }
            
        } else if (status === 'pending') {
            addLog('info', 'PIX GERADO - ' + orderCode);
            
            if (pendingPixOrders.has(orderCode)) {
                clearTimeout(pendingPixOrders.get(orderCode).timeout);
            }
            
            const timeout = setTimeout(async () => {
                addLog('timeout', 'TIMEOUT PIX - ' + orderCode);
                pendingPixOrders.delete(orderCode);
                
                const sendResult = await sendToN8N(data, 'pix_timeout');
                
                if (sendResult.success) {
                    addLog('success', 'PIX TIMEOUT enviado - ' + orderCode);
                } else {
                    addLog('error', 'ERRO PIX TIMEOUT - ' + orderCode);
                }
                
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
        
        res.status(200).json({ 
            success: true, 
            order_code: orderCode,
            status: status
        });
        
    } catch (error) {
        addLog('error', 'ERRO webhook Perfect: ' + error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Função para enviar para N8N
async function sendToN8N(data, eventType) {
    try {
        const payload = {
            ...data,
            event_type: eventType,
            processed_at: new Date().toISOString(),
            system_info: {
                source: 'perfect-webhook-system-v2',
                version: '2.1'
            }
        };
        
        addLog('info', 'Enviando para N8N - Tipo: ' + eventType);
        
        const response = await axios.post(N8N_WEBHOOK_URL, payload, {
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Perfect-Webhook-System-v2/2.1'
            },
            timeout: 15000
        });
        
        addLog('webhook_sent', 'Enviado para N8N - Tipo: ' + eventType + ' | Status: ' + response.status);
        
        return { success: true, status: response.status, data: response.data };
        
    } catch (error) {
        const errorMessage = error.response ? 
            'HTTP ' + error.response.status + ': ' + error.response.statusText : 
            error.message;
            
        addLog('error', 'ERRO enviar N8N - Tipo: ' + eventType + ' | Erro: ' + errorMessage);
        
        return { success: false, error: errorMessage };
    }
}

// Endpoint status dos leads
app.get('/leads-status', (req, res) => {
    const responsesList = Array.from(leadResponses.entries()).map(([phone, data]) => ({
        phone: phone,
        message: data.message?.substring(0, 100) + '...',
        timestamp: data.timestamp,
        time_ago: Math.round((Date.now() - data.timestamp) / 1000 / 60) + ' min atrás'
    }));
    
    const purchasesList = Array.from(leadPurchases.entries()).map(([phone, data]) => ({
        phone: phone,
        order_code: data.orderCode,
        customer_name: data.customerName,
        amount: data.amount,
        timestamp: data.timestamp,
        time_ago: Math.round((Date.now() - data.timestamp) / 1000 / 60) + ' min atrás'
    }));
    
    res.json({
        leads_responded: responsesList.length,
        leads_waiting_response: purchasesList.length,
        responses: responsesList,
        waiting_response: purchasesList,
        timestamp: new Date().toISOString()
    });
});

// Endpoint status geral
app.get('/status', (req, res) => {
    const stats = {
        total_webhooks_received: systemLogs.filter(log => log.type === 'webhook_received').length,
        approved_received: systemLogs.filter(log => log.type === 'webhook_received' && log.data?.status === 'approved').length,
        pix_generated: systemLogs.filter(log => log.type === 'webhook_received' && log.data?.status === 'pending').length,
        webhooks_sent: systemLogs.filter(log => log.type === 'webhook_sent').length,
        leads_responded: leadResponses.size,
        leads_waiting: leadPurchases.size,
        errors: systemLogs.filter(log => log.type === 'error').length
    };
    
    res.json({
        system_status: 'online',
        timestamp: new Date().toISOString(),
        pending_pix_orders: pendingPixOrders.size,
        lead_interaction_stats: {
            responded: leadResponses.size,
            waiting_response: leadPurchases.size
        },
        logs_last_hour: systemLogs,
        statistics: stats,
        n8n_webhook_url: N8N_WEBHOOK_URL
    });
});

// Configurar URL N8N
app.post('/config/n8n-url', (req, res) => {
    const url = req.body.url;
    if (url) {
        process.env.N8N_WEBHOOK_URL = url;
        addLog('info', 'URL N8N atualizada: ' + url);
        res.json({ success: true, message: 'URL configurada' });
    } else {
        res.status(400).json({ success: false, message: 'URL não fornecida' });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'online',
        timestamp: new Date().toISOString(),
        pending_orders: pendingPixOrders.size,
        leads_interaction: {
            responded: leadResponses.size,
            waiting: leadPurchases.size
        },
        uptime: process.uptime()
    });
});

// Interface super simples (SEM template strings problemáticos)
app.get('/', (req, res) => {
    const htmlContent = '<!DOCTYPE html>' +
        '<html>' +
        '<head>' +
        '<title>Webhook Vendas v2.1</title>' +
        '<meta charset="utf-8">' +
        '<style>' +
        'body { font-family: Arial, sans-serif; padding: 20px; background: #f5f5f5; }' +
        '.container { max-width: 800px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; }' +
        'h1 { color: #333; text-align: center; }' +
        '.status { background: #4CAF50; color: white; padding: 15px; border-radius: 5px; margin: 20px 0; text-align: center; }' +
        '.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin: 20px 0; }' +
        '.stat-card { background: #f8f9fa; padding: 20px; border-radius: 5px; text-align: center; border-left: 4px solid #007bff; }' +
        '.stat-value { font-size: 2em; font-weight: bold; color: #007bff; }' +
        '.stat-label { color: #666; font-size: 0.9em; }' +
        '.btn { background: #007bff; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; margin: 5px; }' +
        '.btn:hover { background: #0056b3; }' +
        '.config { background: #f8f9fa; padding: 20px; border-radius: 5px; margin: 20px 0; }' +
        '.input-group { display: flex; gap: 10px; margin: 10px 0; }' +
        '.form-input { flex: 1; padding: 10px; border: 1px solid #ddd; border-radius: 5px; }' +
        '</style>' +
        '</head>' +
        '<body>' +
        '<div class="container">' +
        '<h1>🚀 Webhook Vendas v2.1</h1>' +
        '<div class="status">' +
        '<strong>Sistema Online</strong> - Monitorando vendas e respostas WhatsApp' +
        '</div>' +
        '<div class="stats">' +
        '<div class="stat-card">' +
        '<div class="stat-value" id="pending-count">0</div>' +
        '<div class="stat-label">PIX Pendentes</div>' +
        '</div>' +
        '<div class="stat-card">' +
        '<div class="stat-value" id="leads-responded">0</div>' +
        '<div class="stat-label">Leads Responderam</div>' +
        '</div>' +
        '<div class="stat-card">' +
        '<div class="stat-value" id="leads-waiting">0</div>' +
        '<div class="stat-label">Aguardando Resposta</div>' +
        '</div>' +
        '<div class="stat-card">' +
        '<div class="stat-value" id="total-received">0</div>' +
        '<div class="stat-label">Total Recebidos</div>' +
        '</div>' +
        '</div>' +
        '<div style="text-align: center; margin: 20px 0;">' +
        '<button class="btn" onclick="refreshStatus()">🔄 Atualizar</button>' +
        '<button class="btn" onclick="viewLeads()">👥 Ver Leads</button>' +
        '</div>' +
        '<div class="config">' +
        '<h3>⚙️ Configuração N8N</h3>' +
        '<div class="input-group">' +
        '<input type="text" class="form-input" id="n8n-url" placeholder="URL do N8N webhook..." value="' + N8N_WEBHOOK_URL + '" />' +
        '<button class="btn" onclick="saveUrl()">💾 Salvar</button>' +
        '</div>' +
        '</div>' +
        '<div class="config">' +
        '<h3>📍 Endpoints Disponíveis</h3>' +
        '<p><strong>Perfect Pay:</strong> /webhook/perfect</p>' +
        '<p><strong>WhatsApp:</strong> /webhook/whatsapp-response</p>' +
        '<p><strong>Status Leads:</strong> /leads-status</p>' +
        '</div>' +
        '</div>' +
        '<script>' +
        'function refreshStatus() {' +
        'fetch("/status")' +
        '.then(r => r.json())' +
        '.then(data => {' +
        'document.getElementById("pending-count").textContent = data.pending_pix_orders;' +
        'document.getElementById("leads-responded").textContent = data.lead_interaction_stats.responded;' +
        'document.getElementById("leads-waiting").textContent = data.lead_interaction_stats.waiting_response;' +
        'document.getElementById("total-received").textContent = data.statistics.total_webhooks_received;' +
        '});' +
        '}' +
        'function viewLeads() {' +
        'fetch("/leads-status")' +
        '.then(r => r.json())' +
        '.then(data => {' +
        'alert("Leads Responderam: " + data.leads_responded + "\\nAguardando: " + data.leads_waiting_response);' +
        '});' +
        '}' +
        'function saveUrl() {' +
        'const url = document.getElementById("n8n-url").value;' +
        'fetch("/config/n8n-url", {' +
        'method: "POST",' +
        'headers: {"Content-Type": "application/json"},' +
        'body: JSON.stringify({url: url})' +
        '})' +
        '.then(r => r.json())' +
        '.then(data => {' +
        'alert(data.message);' +
        'refreshStatus();' +
        '});' +
        '}' +
        'setInterval(refreshStatus, 10000);' +
        'refreshStatus();' +
        '</script>' +
        '</body>' +
        '</html>';
    
    res.send(htmlContent);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    addLog('info', 'Sistema v2.1 iniciado na porta ' + PORT);
    addLog('info', 'Perfect: /webhook/perfect');
    addLog('info', 'WhatsApp: /webhook/whatsapp-response');
    addLog('info', 'Interface: /');
    console.log('Servidor rodando na porta ' + PORT);
});
