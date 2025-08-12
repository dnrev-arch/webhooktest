const express = require('express');
const axios = require('axios');
const app = express();

// Armazenamento em memória (lista de pedidos PIX pendentes)
let pendingPixOrders = new Map();

// Sistema de logs das últimas 1 hora
let systemLogs = [];
const LOG_RETENTION_TIME = 60 * 60 * 1000; // 1 hora em millisegundos

// NOVO: Sistema de controle de respostas dos leads
let leadResponses = new Map(); // Armazena leads que responderam
let leadPurchases = new Map(); // Armazena leads que compraram (aguardando resposta)

// Configurações
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://n8n.flowzap.fun/webhook/f23c49cb-b6ed-4eea-84d8-3fe25753d9a5';
const PIX_TIMEOUT = 7 * 60 * 1000; // 7 minutos em millisegundos

app.use(express.json());

// Função para adicionar logs com timestamp
function addLog(type, message, data = null) {
    const logEntry = {
        timestamp: new Date().toISOString(),
        type: type, // 'info', 'success', 'error', 'webhook_received', 'webhook_sent', 'timeout'
        message: message,
        data: data
    };
    
    systemLogs.push(logEntry);
    console.log(`[${logEntry.timestamp}] ${type.toUpperCase()}: ${message}`);
    
    // Remove logs mais antigos que 1 hora
    const oneHourAgo = Date.now() - LOG_RETENTION_TIME;
    systemLogs = systemLogs.filter(log => new Date(log.timestamp).getTime() > oneHourAgo);
}

// NOVO: Função para limpar dados antigos de leads (mais de 24h)
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
    
    addLog('info', `🧹 Limpeza automática - Leads antigos removidos`);
}

// Limpa dados antigos a cada hora
setInterval(cleanOldLeads, 60 * 60 * 1000);

// NOVO: Endpoint para receber RESPOSTAS do WhatsApp (Evolution API)
app.post('/webhook/whatsapp-response', async (req, res) => {
    try {
        const data = req.body;
        
        // Diferentes formatos que a Evolution API pode enviar
        const phone = data.key?.remoteJid?.replace('@s.whatsapp.net', '') || 
                     data.data?.key?.remoteJid?.replace('@s.whatsapp.net', '') ||
                     data.phone || data.from || data.number;
                     
        const message = data.data?.message?.conversation || 
                       data.data?.message?.extendedTextMessage?.text ||
                       data.message || data.text || data.body || '';
        
        // Verifica se é uma mensagem válida (não de grupo, não vazia)
        if (phone && message && !phone.includes('@g.us')) {
            // Registra que o lead respondeu
            leadResponses.set(phone, {
                timestamp: Date.now(),
                message: message,
                phone: phone,
                full_data: data
            });
            
            addLog('info', `📱 LEAD RESPONDEU - Telefone: ${phone} | Mensagem: ${message.substring(0, 50)}...`, {
                phone: phone,
                message: message,
                webhook_data: data
            });
            
            // Verifica se esse lead tem uma compra registrada (aguardando resposta)
            const hasPurchase = leadPurchases.has(phone);
            
            if (hasPurchase) {
                const purchaseData = leadPurchases.get(phone);
                
                addLog('success', `🎯 LEAD ATIVO IDENTIFICADO - Telefone: ${phone} | Pedido: ${purchaseData.orderCode}`);
                
                // Prepara dados para enviar ao N8N (continuação do fluxo)
                const continuationPayload = {
                    ...purchaseData.originalData, // Dados originais da compra
                    lead_interaction: {
                        responded: true,
                        response_message: message,
                        response_time: new Date().toISOString(),
                        phone: phone,
                        customer_name: purchaseData.customerName
                    },
                    event_type: 'lead_active_continuation', // Novo tipo de evento
                    processed_at: new Date().toISOString(),
                    system_info: {
                        source: 'perfect-webhook-system-v2',
                        version: '2.1'
                    }
                };
                
                // Envia para N8N
                const sendResult = await sendToN8N(continuationPayload, 'lead_active_continuation');
                
                if (sendResult.success) {
                    addLog('success', `✅ FLUXO CONTINUADO - Lead ativo: ${phone} | Pedido: ${purchaseData.orderCode}`);
                    
                    // Remove da lista de aguardando resposta (já processou)
                    leadPurchases.delete(phone);
                    leadResponses.delete(phone);
                } else {
                    addLog('error', `❌ ERRO ao continuar fluxo - Lead: ${phone} | Erro: ${sendResult.error}`);
                }
            } else {
                addLog('info', `📝 Resposta registrada (sem compra pendente) - Telefone: ${phone}`);
            }
        }
        
        res.status(200).json({ 
            success: true, 
            message: 'Resposta WhatsApp processada',
            lead_responded: true,
            phone: phone
        });
        
    } catch (error) {
        addLog('error', `❌ ERRO ao processar resposta WhatsApp: ${error.message}`, { 
            error: error.stack,
            request_body: req.body 
        });
        res.status(500).json({ success: false, error: error.message });
    }
});

// Endpoint principal que recebe webhooks da Perfect (MODIFICADO)
app.post('/webhook/perfect', async (req, res) => {
    try {
        const data = req.body;
        const orderCode = data.code;
        const status = data.sale_status_enum_key;
        const customerName = data.customer?.full_name || 'N/A';
        const amount = data.sale_amount || 0;
        
        // NOVO: Extrai telefone do cliente para controle de interação
        const customerPhone = (data.customer?.phone_extension_number || '') + 
                             (data.customer?.phone_area_code || '') + 
                             (data.customer?.phone_number || '');
        
        addLog('webhook_received', `Webhook recebido - Pedido: ${orderCode} | Status: ${status} | Cliente: ${customerName} | Telefone: ${customerPhone} | Valor: R$ ${amount}`, {
            order_code: orderCode,
            status: status,
            customer: customerName,
            phone: customerPhone,
            amount: amount,
            full_data: data
        });
        
        if (status === 'approved') {
            // VENDA APROVADA - Envia direto pro N8N (IMEDIATO)
            addLog('info', `✅ VENDA APROVADA - Processando pedido: ${orderCode}`);
            
            // Remove da lista de PIX pendentes se existir
            if (pendingPixOrders.has(orderCode)) {
                clearTimeout(pendingPixOrders.get(orderCode).timeout);
                pendingPixOrders.delete(orderCode);
                addLog('info', `🗑️ Removido da lista PIX pendente: ${orderCode}`);
            }
            
            // NOVO: Registra a compra para controle de interação futura
            if (customerPhone && customerPhone.length >= 10) {
                leadPurchases.set(customerPhone, {
                    timestamp: Date.now(),
                    originalData: data,
                    orderCode: orderCode,
                    customerName: customerName,
                    amount: amount,
                    phone: customerPhone
                });
                
                addLog('info', `📝 COMPRA REGISTRADA para controle de interação - Telefone: ${customerPhone} | Pedido: ${orderCode}`);
            }
            
            // Envia webhook completo para N8N (primeira mensagem)
            const sendResult = await sendToN8N(data, 'approved');
            
            if (sendResult.success) {
                addLog('success', `✅ VENDA APROVADA enviada com sucesso para N8N: ${orderCode}`);
            } else {
                addLog('error', `❌ ERRO ao enviar VENDA APROVADA para N8N: ${orderCode} - ${sendResult.error}`);
            }
            
        } else if (status === 'pending') {
            // PIX GERADO - Armazena e agenda timeout (IGUAL AO ANTERIOR)
            addLog('info', `⏳ PIX GERADO - Aguardando pagamento: ${orderCode} | Timeout: 7 minutos`);
            
            // Se já existe, cancela o timeout anterior
            if (pendingPixOrders.has(orderCode)) {
                clearTimeout(pendingPixOrders.get(orderCode).timeout);
                addLog('info', `🔄 Timeout anterior cancelado para: ${orderCode}`);
            }
            
            // Cria timeout de 7 minutos
            const timeout = setTimeout(async () => {
                addLog('timeout', `⏰ TIMEOUT de 7 minutos atingido para: ${orderCode} - Enviando PIX não pago`);
                
                // Remove da lista
                pendingPixOrders.delete(orderCode);
                
                // Envia webhook completo PIX não pago para N8N
                const sendResult = await sendToN8N(data, 'pix_timeout');
                
                if (sendResult.success) {
                    addLog('success', `✅ PIX TIMEOUT enviado com sucesso para N8N: ${orderCode}`);
                } else {
                    addLog('error', `❌ ERRO ao enviar PIX TIMEOUT para N8N: ${orderCode} - ${sendResult.error}`);
                }
                
            }, PIX_TIMEOUT);
            
            // Armazena na lista
            pendingPixOrders.set(orderCode, {
                data: data,
                timeout: timeout,
                timestamp: new Date(),
                customer_name: customerName,
                amount: amount,
                customer_phone: customerPhone
            });
            
            addLog('info', `📝 Pedido PIX armazenado: ${orderCode} | Cliente: ${customerName} | Telefone: ${customerPhone} | Valor: R$ ${amount}`);
            
        } else {
            // Status desconhecido
            addLog('info', `❓ Status desconhecido recebido: ${status} para pedido: ${orderCode}`);
        }
        
        res.status(200).json({ 
            success: true, 
            message: 'Webhook processado com sucesso',
            order_code: orderCode,
            status: status,
            processed_at: new Date().toISOString()
        });
        
    } catch (error) {
        addLog('error', `❌ ERRO ao processar webhook: ${error.message}`, { error: error.stack });
        res.status(500).json({ success: false, error: error.message });
    }
});

// Função para enviar dados para N8N (IGUAL AO ANTERIOR)
async function sendToN8N(data, eventType) {
    try {
        // Envia o webhook COMPLETO da Perfect + nosso event_type
        const payload = {
            ...data, // WEBHOOK COMPLETO DA PERFECT
            event_type: eventType, // 'approved', 'pix_timeout', ou 'lead_active_continuation'
            processed_at: new Date().toISOString(),
            system_info: {
                source: 'perfect-webhook-system-v2',
                version: '2.1'
            }
        };
        
        addLog('info', `🚀 Tentando enviar para N8N - Pedido: ${data.code} | Tipo: ${eventType} | URL: ${N8N_WEBHOOK_URL}`);
        
        const response = await axios.post(N8N_WEBHOOK_URL, payload, {
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Perfect-Webhook-System-v2/2.1'
            },
            timeout: 15000 // 15 segundos de timeout
        });
        
        addLog('webhook_sent', `✅ Webhook enviado com SUCESSO para N8N - Pedido: ${data.code} | Tipo: ${eventType} | Status HTTP: ${response.status}`, {
            order_code: data.code,
            event_type: eventType,
            http_status: response.status,
            response_data: response.data
        });
        
        return { success: true, status: response.status, data: response.data };
        
    } catch (error) {
        const errorMessage = error.response ? 
            `HTTP ${error.response.status}: ${error.response.statusText}` : 
            error.message;
            
        addLog('error', `❌ ERRO ao enviar para N8N - Pedido: ${data.code} | Erro: ${errorMessage}`, {
            order_code: data.code,
            event_type: eventType,
            error: errorMessage,
            error_details: error.response?.data
        });
        
        return { success: false, error: errorMessage };
    }
}

// NOVO: Endpoint para verificar status de leads que responderam
app.get('/leads-status', (req, res) => {
    const responsesList = Array.from(leadResponses.entries()).map(([phone, data]) => ({
        phone: phone,
        message: data.message?.substring(0, 100) + '...',
        timestamp: data.timestamp,
        time_ago: Math.round((Date.now() - data.timestamp) / 1000 / 60) + ' minutos atrás'
    }));
    
    const purchasesList = Array.from(leadPurchases.entries()).map(([phone, data]) => ({
        phone: phone,
        order_code: data.orderCode,
        customer_name: data.customerName,
        amount: data.amount,
        timestamp: data.timestamp,
        time_ago: Math.round((Date.now() - data.timestamp) / 1000 / 60) + ' minutos atrás',
        waiting_response: true
    }));
    
    res.json({
        leads_responded: responsesList.length,
        leads_waiting_response: purchasesList.length,
        total_interactions: responsesList.length + purchasesList.length,
        responses: responsesList,
        waiting_response: purchasesList,
        timestamp: new Date().toISOString()
    });
});

// Endpoint para monitoramento completo (MODIFICADO)
app.get('/status', (req, res) => {
    const pendingList = Array.from(pendingPixOrders.entries()).map(([code, order]) => ({
        code: code,
        customer_name: order.customer_name,
        customer_phone: order.customer_phone,
        amount: order.amount,
        created_at: order.timestamp,
        remaining_time: Math.max(0, PIX_TIMEOUT - (new Date() - order.timestamp))
    }));
    
    // Estatísticas dos logs da última hora
    const stats = {
        total_webhooks_received: systemLogs.filter(log => log.type === 'webhook_received').length,
        approved_received: systemLogs.filter(log => log.type === 'webhook_received' && log.data?.status === 'approved').length,
        pix_generated: systemLogs.filter(log => log.type === 'webhook_received' && log.data?.status === 'pending').length,
        webhooks_sent: systemLogs.filter(log => log.type === 'webhook_sent').length,
        timeouts_triggered: systemLogs.filter(log => log.type === 'timeout').length,
        errors: systemLogs.filter(log => log.type === 'error').length,
        // NOVO: Estatísticas de interação
        leads_responded: leadResponses.size,
        leads_waiting_response: leadPurchases.size,
        total_lead_interactions: leadResponses.size + leadPurchases.size
    };
    
    res.json({
        system_status: 'online',
        timestamp: new Date().toISOString(),
        pending_pix_orders: pendingPixOrders.size,
        orders: pendingList,
        // NOVO: Dados de interação com leads
        lead_interaction_stats: {
            responded: leadResponses.size,
            waiting_response: leadPurchases.size,
            total: leadResponses.size + leadPurchases.size
        },
        logs_last_hour: systemLogs,
        statistics: stats,
        n8n_webhook_url: N8N_WEBHOOK_URL,
        // NOVO: Endpoints disponíveis
        available_endpoints: {
            perfect_webhook: '/webhook/perfect',
            whatsapp_responses: '/webhook/whatsapp-response',
            leads_status: '/leads-status',
            system_status: '/status'
        }
    });
});

// Endpoint para configurar URL do N8N (IGUAL AO ANTERIOR)
app.post('/config/n8n-url', (req, res) => {
    const { url } = req.body;
    if (url) {
        process.env.N8N_WEBHOOK_URL = url;
        addLog('info', `⚙️ URL do N8N atualizada para: ${url}`);
        res.json({ success: true, message: 'URL do N8N configurada' });
    } else {
        res.status(400).json({ success: false, message: 'URL não fornecida' });
    }
});

// Endpoint de health check (IGUAL AO ANTERIOR)
app.get('/health', (req, res) => {
    res.json({
        status: 'online',
        timestamp: new Date().toISOString(),
        pending_orders: pendingPixOrders.size,
        leads_interaction: {
            responded: leadResponses.size,
            waiting: leadPurchases.size
        },
        logs_count: systemLogs.length,
        uptime: process.uptime()
    });
});

// Interface web nova e clean (IGUAL AO ANTERIOR)
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Webhook Vendas v2.1</title>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body { 
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    min-height: 100vh;
                    padding: 20px;
                }
                .container { 
                    max-width: 1200px; 
                    margin: 0 auto; 
                    background: rgba(255, 255, 255, 0.95);
                    backdrop-filter: blur(10px);
                    border-radius: 20px; 
                    padding: 30px; 
                    box-shadow: 0 20px 40px rgba(0,0,0,0.1);
                    margin-bottom: 20px;
                }
                h1 { 
                    color: #2d3748; 
                    text-align: center; 
                    font-size: 2.5rem; 
                    font-weight: 700; 
                    margin-bottom: 40px;
                    background: linear-gradient(135deg, #667eea, #764ba2);
                    -webkit-background-clip: text;
                    -webkit-text-fill-color: transparent;
                    background-clip: text;
                }
                .version { 
                    text-align: center; 
                    color: #718096; 
                    font-size: 0.9rem; 
                    margin-bottom: 30px;
                }
                .section-title { 
                    color: #4a5568; 
                    font-size: 1.3rem; 
                    font-weight: 600; 
                    margin-bottom: 20px;
                    display: flex;
                    align-items: center;
                    border-bottom: 2px solid #e2e8f0;
                    padding-bottom: 10px;
                }
                .icon { 
                    width: 24px; 
                    height: 24px; 
                    margin-right: 10px; 
                    fill: currentColor;
                }
                .status-card { 
                    background: linear-gradient(135deg, #48bb78, #38a169);
                    color: white; 
                    padding: 20px; 
                    border-radius: 15px; 
                    margin-bottom: 30px;
                    box-shadow: 0 10px 25px rgba(72, 187, 120, 0.3);
                }
                .status-content {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    flex-wrap: wrap;
                    gap: 20px;
                }
                .status-item {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    text-align: center;
                }
                .status-label {
                    font-size: 0.9rem;
                    opacity: 0.9;
                    margin-bottom: 5px;
                }
                .status-value {
                    font-size: 1.5rem;
                    font-weight: 700;
                }
                .stats-grid { 
                    display: grid; 
                    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); 
                    gap: 20px; 
                    margin-bottom: 30px; 
                }
                .stat-card { 
                    background: white;
                    border: 1px solid #e2e8f0;
                    padding: 25px; 
                    border-radius: 15px; 
                    text-align: center;
                    transition: all 0.3s ease;
                    position: relative;
                    overflow: hidden;
                }
                .stat-card::before {
                    content: '';
                    position: absolute;
                    top: 0;
                    left: 0;
                    right: 0;
                    height: 4px;
                    background: linear-gradient(90deg, #667eea, #764ba2);
                }
                .stat-card:hover {
                    transform: translateY(-5px);
                    box-shadow: 0 15px 35px rgba(0,0,0,0.1);
                }
                .stat-title { 
                    color: #718096; 
                    font-size: 0.9rem; 
                    font-weight: 500; 
                    margin-bottom: 10px;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                }
                .stat-value { 
                    color: #2d3748; 
                    font-size: 2.5rem; 
                    font-weight: 700; 
                }
                .controls {
                    display: flex;
                    gap: 15px;
                    flex-wrap: wrap;
                    margin-bottom: 30px;
                }
                .btn { 
                    background: linear-gradient(135deg, #667eea, #764ba2);
                    color: white; 
                    border: none; 
                    padding: 12px 25px; 
                    border-radius: 25px; 
                    cursor: pointer; 
                    font-weight: 600;
                    font-size: 0.95rem;
                    transition: all 0.3s ease;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }
                .btn:hover { 
                    transform: translateY(-2px);
                    box-shadow: 0 10px 25px rgba(102, 126, 234, 0.4);
                }
                .btn-success { 
                    background: linear-gradient(135deg, #48bb78, #38a169);
                }
                .btn-success:hover {
                    box-shadow: 0 10px 25px rgba(72, 187, 120, 0.4);
                }
                .input-group {
                    display: flex;
                    gap: 15px;
                    align-items: center;
                    flex-wrap: wrap;
                    margin-bottom: 20px;
                }
                .form-input { 
                    flex: 1;
                    min-width: 300px;
                    padding: 12px 20px; 
                    border: 2px solid #e2e8f0; 
                    border-radius: 25px; 
                    font-size: 0.95rem;
                    transition: all 0.3s ease;
                    background: white;
                }
                .form-input:focus {
                    outline: none;
                    border-color: #667eea;
                    box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
                }
                .new-feature {
                    background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
                    color: white;
                    padding: 20px;
                    border-radius: 15px;
                    margin-bottom: 30px;
                    text-align: center;
                }
                .new-feature h3 {
                    margin-bottom: 10px;
                    font-size: 1.2rem;
                }
                .new-feature p {
                    opacity: 0.9;
                    font-size: 0.95rem;
                }
                @media (max-width: 768px) {
                    body { padding: 10px; }
                    .container { padding: 20px; }
                    h1 { font-size: 2rem; }
                    .stats-grid { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
                    .form-input { min-width: 250px; }
                }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>Webhook Vendas</h1>
                <div class="version">Sistema v2.1 com Controle de Interação</div>
                
                <div class="new-feature">
                    <h3>🎉 Nova Funcionalidade!</h3>
                    <p>Agora o sistema detecta quando leads respondem e continua o fluxo automaticamente apenas para leads ativos!</p>
                </div>
                
                <div class="status-card">
                    <div class="status-content">
                        <div class="status-item">
                            <div class="status-label">Status</div>
                            <div class="status-value">Online</div>
                        </div>
                        <div class="status-item">
                            <div class="status-label">PIX Pendentes</div>
                            <div class="status-value" id="pending-count">0</div>
                        </div>
                        <div class="status-item">
                            <div class="status-label">Leads Responderam</div>
                            <div class="status-value" id="leads-responded">0</div>
                        </div>
                        <div class="status-item">
                            <div class="status-label">Aguardando Resposta</div>
                            <div class="status-value" id="leads-waiting">0</div>
                        </div>
                    </div>
                </div>
                
                <div class="stats-grid">
                    <div class="stat-card">
                        <div class="stat-title">Webhooks Recebidos</div>
                        <div class="stat-value" id="total-received">0</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-title">Vendas Aprovadas</div>
                        <div class="stat-value" id="approved-count">0</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-title">PIX Gerados</div>
                        <div class="stat-value" id="pix-count">0</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-title">Enviados N8N</div>
                        <div class="stat-value" id="sent-count">0</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-title">Leads Ativos</div>
                        <div class="stat-value" id="active-leads">0</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-title">Erros</div>
                        <div class="stat-value" id="error-count">0</div>
                    </div>
                </div>
                
                <div class="controls">
                    <button class="btn btn-success" onclick="refreshStatus()">
                        <svg class="icon" viewBox="0 0 24 24">
                            <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
                        </svg>
                        Atualizar
                    </button>
                    <button class="btn" onclick="viewLeadsStatus()">
                        <svg class="icon" viewBox="0 0 24 24">
                            <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/>
                            <circle cx="9" cy="7" r="4"/>
                            <path d="m22 21-3-3m0 0a5.002 5.002 0 10-7.07-7.071A5.002 5.002 0 0019 18z"/>
                        </svg>
                        Ver Leads
                    </button>
                </div>
            </div>
            
            <div class="container">
                <h2 class="section-title">
                    <svg class="icon" viewBox="0 0 24 24">
                        <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/>
                        <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
                    </svg>
                    Configuração N8N
                </h2>
                <div class="input-group">
                    <input type="text" class="form-input" id="n8n-url" placeholder="https://n8n.flowzap.fun/webhook/..." value="${N8N_WEBHOOK_URL}" />
                    <button class="btn" onclick="saveN8nUrl()">
                        <svg class="icon" viewBox="0 0 24 24">
                            <path d="M8 4H6a2 2 0 00-2 2v12a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-2m-4-1v8m0 0l3-3m-3 3L9 8"/>
                        </svg>
                        Salvar URL
                    </button>
                </div>
                
                <div class="new-feature">
                    <h3>📍 Endpoints Disponíveis:</h3>
                    <p><strong>Perfect Pay:</strong> /webhook/perfect</p>
                    <p><strong>WhatsApp Respostas:</strong> /webhook/whatsapp-response</p>
                    <p><strong>Status dos Leads:</strong> /leads-status</p>
                </div>
            </div>
            
            <script>
                let allOrders = [];
                let leadsData = {};
                
                function refreshStatus() {
                    fetch('/status')
                        .then(r => r.json())
                        .then(data => {
                            // Atualiza contadores principais
                            document.getElementById('pending-count').textContent = data.pending_pix_orders;
                            document.getElementById('leads-responded').textContent = data.lead_interaction_stats.responded;
                            document.getElementById('leads-waiting').textContent = data.lead_interaction_stats.waiting;
                            
                            // Atualiza estatísticas
                            document.getElementById('total-received').textContent = data.statistics.total_webhooks_received;
                            document.getElementById('approved-count').textContent = data.statistics.approved_received;
                            document.getElementById('pix-count').textContent = data.statistics.pix_generated;
                            document.getElementById('sent-count').textContent = data.statistics.webhooks_sent;
                            document.getElementById('active-leads').textContent = data.statistics.total_lead_interactions;
                            document.getElementById('error-count').textContent = data.statistics.errors;
                        })
                        .catch(err => {
                            console.error('Erro ao buscar status:', err);
                        });
                }
                
                function viewLeadsStatus() {
                    fetch('/leads-status')
                        .then(r => r.json())
                        .then(data => {
                            leadsData = data;
                            showLeadsModal();
                        })
                        .catch(err => {
                            console.error('Erro ao buscar leads:', err);
                            alert('Erro ao carregar dados dos leads');
                        });
                }
                
                function showLeadsModal() {
                    const modal = document.createElement('div');
                    modal.style.cssText = `
                        position: fixed; top: 0; left: 0; width: 100%; height: 100%; 
                        background: rgba(0,0,0,0.8); z-index: 1000; display: flex; 
                        align-items: center; justify-content: center; padding: 20px;
                    `;
                    
                    const content = document.createElement('div');
                    content.style.cssText = `
                        background: white; border-radius: 15px; padding: 30px; 
                        max-width: 800px; width: 100%; max-height: 80vh; overflow-y: auto;
                    `;
                    
                    content.innerHTML = `
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                            <h2 style="color: #2d3748; margin: 0;">Status dos Leads</h2>
                            <button onclick="this.closest('.modal').remove()" style="background: none; border: none; font-size: 24px; cursor: pointer;">&times;</button>
                        </div>
                        
                        <div style="margin-bottom: 30px;">
                            <h3 style="color: #48bb78; margin-bottom: 10px;">📱 Leads que Responderam (${leadsData.leads_responded})</h3>
                            ${leadsData.responses.length > 0 ? 
                                leadsData.responses.map(lead => `
                                    <div style="background: #f0fff4; padding: 15px; border-radius: 10px; margin-bottom: 10px; border-left: 4px solid #48bb78;">
                                        <strong>Tel:</strong> ${lead.phone}<br>
                                        <strong>Mensagem:</strong> ${lead.message}<br>
                                        <strong>Há:</strong> ${lead.time_ago}
                                    </div>
                                `).join('') : 
                                '<p style="color: #718096; font-style: italic;">Nenhum lead respondeu ainda</p>'
                            }
                        </div>
                        
                        <div>
                            <h3 style="color: #f56565; margin-bottom: 10px;">⏳ Aguardando Resposta (${leadsData.leads_waiting_response})</h3>
                            ${leadsData.waiting_response.length > 0 ? 
                                leadsData.waiting_response.map(lead => `
                                    <div style="background: #fff5f5; padding: 15px; border-radius: 10px; margin-bottom: 10px; border-left: 4px solid #f56565;">
                                        <strong>Tel:</strong> ${lead.phone}<br>
                                        <strong>Cliente:</strong> ${lead.customer_name}<br>
                                        <strong>Pedido:</strong> ${lead.order_code}<br>
                                        <strong>Valor:</strong> R$ ${lead.amount}<br>
                                        <strong>Há:</strong> ${lead.time_ago}
                                    </div>
                                `).join('') : 
                                '<p style="color: #718096; font-style: italic;">Nenhum lead aguardando resposta</p>'
                            }
                        </div>
                    `;
                    
                    modal.appendChild(content);
                    modal.className = 'modal';
                    document.body.appendChild(modal);
                    
                    modal.onclick = (e) => {
                        if (e.target === modal) modal.remove();
                    };
                }
                
                function saveN8nUrl() {
                    const url = document.getElementById('n8n-url').value;
                    fetch('/config/n8n-url', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({url: url})
                    })
                    .then(r => r.json())
                    .then(data => {
                        alert(data.message);
                        if (data.success) refreshStatus();
                    });
                }
                
                // Atualiza automaticamente a cada 10 segundos
                setInterval(refreshStatus, 10000);
                
                // Carrega dados iniciais
                refreshStatus();
            </script>
        </body>
        </html>
    `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    addLog('info', `🚀 Sistema Perfect Webhook v2.1 iniciado na porta ${PORT}`);
    addLog('info', `📡 Webhook Perfect Pay: https://controle-webhook-perfect.flowzap.fun/webhook/perfect`);
    addLog('info', `📱 Webhook WhatsApp: https://controle-webhook-perfect.flowzap.fun/webhook/whatsapp-response`);
    addLog('info', `🖥️ Interface Monitor: https://controle-webhook-perfect.flowzap.fun`);
    addLog('info', `🎯 N8N Webhook: ${N8N_WEBHOOK_URL}`);
    addLog('info', `👥 Endpoint Leads: https://controle-webhook-perfect.flowzap.fun/leads-status`);
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
    console.log(`📡 Webhook URL Perfect: https://controle-webhook-perfect.flowzap.fun/webhook/perfect`);
    console.log(`📱 Webhook URL WhatsApp: https://controle-webhook-perfect.flowzap.fun/webhook/whatsapp-response`);
    console.log(`🖥️ Interface Monitor: https://controle-webhook-perfect.flowzap.fun`);
    console.log(`🎯 N8N Webhook: ${N8N_WEBHOOK_URL}`);
    console.log(`👥 Leads Status: https://controle-webhook-perfect.flowzap.fun/leads-status`);
});
