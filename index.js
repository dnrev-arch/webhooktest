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
const N8N_WHATSAPP_URL = process.env.N8N_WHATSAPP_URL || 'https://n8n.flowzap.fun/webhook/c0d9ac75-a0db-426c-ad25-09f5d0644c6f';
const PIX_TIMEOUT = 7 * 60 * 1000; // 7 minutos

app.use(express.json());

// Função para normalizar telefones
function normalizePhone(phone) {
    if (!phone) return '';
    
    // Remove todos os caracteres não numéricos
    let normalized = phone.toString().replace(/\D/g, '');
    
    console.log('📱 Normalizando telefone:', {
        original: phone,
        apenas_numeros: normalized
    });
    
    // Se tem 13 dígitos e começa com 55 (Brasil)
    if (normalized.length === 13 && normalized.startsWith('55')) {
        normalized = normalized.substring(2); // Remove 55
    }
    
    // Se tem 12 dígitos
    if (normalized.length === 12) {
        normalized = normalized.substring(1); // Remove primeiro dígito
    }
    
    // Se tem 10 dígitos, adiciona 9 no celular
    if (normalized.length === 10) {
        const ddd = normalized.substring(0, 2);
        const numero = normalized.substring(2);
        normalized = ddd + '9' + numero;
    }
    
    console.log('📱 Telefone normalizado final:', normalized);
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

// WEBHOOK WHATSAPP - VERSÃO DEBUG TOTAL PARA CAPTURAR TUDO
app.post('/webhook/whatsapp-response', async (req, res) => {
    try {
        console.log('\n🔍 === WEBHOOK WHATSAPP DEBUG TOTAL ===');
        console.log('Body completo:', JSON.stringify(req.body, null, 2));
        
        const data = req.body;
        
        // REGISTRAR TUDO que chega - para debug
        addLog('info', '📱 WEBHOOK WHATSAPP RECEBIDO: ' + JSON.stringify(data).substring(0, 200) + '...');
        
        // FORÇAR detecção de QUALQUER telefone válido
        let phone = null;
        let message = null;
        
        // Tentar TODAS as formas possíveis de extrair telefone
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
                console.log('✅ Telefone encontrado:', phone, 'via:', attempt);
                addLog('info', '📱 Telefone detectado: ' + phone + ' via: ' + attempt);
                break;
            }
        }
        
        // Tentar TODAS as formas possíveis de extrair mensagem
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
                console.log('✅ Mensagem encontrada:', message.substring(0, 50) + '...');
                addLog('info', '💬 Mensagem detectada: ' + message.substring(0, 50) + '...');
                break;
            }
        }
        
        // DEBUG: Log do que foi encontrado
        console.log('📱 Resultado extração:', {
            phone: phone,
            message: message ? message.substring(0, 50) + '...' : null,
            hasPhone: !!phone,
            hasMessage: !!message
        });
        
        // SE encontrou telefone E mensagem, processar
        if (phone && message) {
            const normalizedPhone = normalizePhone(phone);
            
            console.log('🎯 PROCESSANDO RESPOSTA:', {
                raw: phone,
                normalized: normalizedPhone,
                message: message.substring(0, 50) + '...'
            });
            
            // Registrar resposta SEMPRE (independente de ter compra)
            leadResponses.set(normalizedPhone, {
                timestamp: Date.now(),
                message: message,
                phone: normalizedPhone,
                full_data: data
            });
            
            addLog('info', `🎉 RESPOSTA DETECTADA - Tel: ${normalizedPhone} | Msg: ${message.substring(0, 50)}...`, {
                phone: normalizedPhone,
                message: message
            });
            
            console.log('📊 Total respostas registradas:', leadResponses.size);
            
            // Verificar se existe compra para este telefone
            const hasPurchase = leadPurchases.has(normalizedPhone);
            console.log('🛒 Tem compra registrada?', hasPurchase);
            console.log('📋 Compras registradas:', Array.from(leadPurchases.keys()));
            
            if (hasPurchase) {
                const purchaseData = leadPurchases.get(normalizedPhone);
                console.log('🛒 Dados da compra encontrada:', purchaseData);
                
                addLog('success', `🚀 LEAD ATIVO DETECTADO - Tel: ${normalizedPhone} | Pedido: ${purchaseData.orderCode}`);
                
                // Preparar dados para continuação do fluxo
                const continuationPayload = {
                    ...purchaseData.originalData,
                    lead_interaction: {
                        responded: true,
                        response_message: message,
                        response_time: new Date().toISOString(),
                        phone: normalizedPhone,
                        customer_name: purchaseData.customerName
                    },
                    event_type: 'lead_active_continuation',
                    processed_at: new Date().toISOString(),
                    system_info: {
                        source: 'perfect-webhook-system-v2',
                        version: '2.1'
                    }
                };
                
                console.log('📤 Enviando continuação para N8N:', JSON.stringify(continuationPayload, null, 2));
                
                const sendResult = await sendToN8N(continuationPayload, 'lead_active_continuation', true);
                
                if (sendResult.success) {
                    addLog('success', `✅ FLUXO CONTINUADO COM SUCESSO - Lead: ${normalizedPhone} | Pedido: ${purchaseData.orderCode}`);
                    console.log('🎯 FLUXO CONTINUADO COM SUCESSO!');
                } else {
                    addLog('error', `❌ ERRO ao continuar fluxo - Lead: ${normalizedPhone} | Erro: ${sendResult.error}`);
                    console.log('❌ ERRO ao enviar continuação para N8N:', sendResult.error);
                }
            } else {
                addLog('info', `⚠️ Resposta sem compra - Tel: ${normalizedPhone}`);
                console.log('⚠️ Lead respondeu mas não tem compra registrada');
            }
        } else {
            console.log('❌ Não foi possível extrair telefone ou mensagem');
            addLog('info', '❌ Webhook WhatsApp: dados insuficientes para processar');
            
            // DEBUG: Mostrar estrutura recebida quando falha
            console.log('📊 Estrutura de dados recebida:', Object.keys(data));
            addLog('info', '📊 Estrutura recebida: ' + Object.keys(data).join(', '));
        }
        
        console.log('=== FIM DEBUG WHATSAPP ===\n');
        
        res.status(200).json({ 
            success: true, 
            message: 'Webhook WhatsApp processado',
            phone: phone,
            normalizedPhone: phone ? normalizePhone(phone) : null,
            hasMessage: !!message,
            totalResponses: leadResponses.size,
            totalPurchases: leadPurchases.size
        });
        
    } catch (error) {
        console.error('❌ Erro no webhook WhatsApp:', error);
        addLog('error', 'ERRO resposta WhatsApp: ' + error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Webhook Perfect Pay - VERSÃO MELHORADA
app.post('/webhook/perfect', async (req, res) => {
    try {
        console.log('\n💰 === DEBUG PERFECT PAY ===');
        console.log('Dados recebidos:', JSON.stringify(req.body, null, 2));
        
        const data = req.body;
        const orderCode = data.code;
        const status = data.sale_status_enum_key;
        const customerName = data.customer?.full_name || 'N/A';
        const amount = data.sale_amount || 0;
        
        // Extrair telefone com debug detalhado
        const phoneOptions = {
            concatenated: (data.customer?.phone_extension_number || '') + 
                         (data.customer?.phone_area_code || '') + 
                         (data.customer?.phone_number || ''),
            direct_phone: data.customer?.phone,
            root_phone: data.phone
        };
        
        console.log('📱 Opções de telefone Perfect Pay:', phoneOptions);
        
        const rawCustomerPhone = phoneOptions.concatenated || phoneOptions.direct_phone || phoneOptions.root_phone;
        const customerPhone = normalizePhone(rawCustomerPhone);
        
        console.log('📱 Telefone Perfect Pay processado:', {
            raw: rawCustomerPhone,
            normalized: customerPhone
        });
        
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
            addLog('info', 'PIX GERADO - ' + orderCode + ' | Tel: ' + customerPhone);
            
            // Registrar compra para monitoramento de resposta
            if (customerPhone && customerPhone.length >= 10) {
                leadPurchases.set(customerPhone, {
                    timestamp: Date.now(),
                    originalData: data,
                    orderCode: orderCode,
                    customerName: customerName,
                    amount: amount,
                    phone: customerPhone
                });
                
                addLog('info', 'COMPRA REGISTRADA para monitoramento - Tel: ' + customerPhone + ' | Pedido: ' + orderCode);
                console.log('📝 Lead adicionado para monitoramento:', customerPhone);
            }
            
            // CORRIGIDO: Envio para N8N FORA do if
            const sendResult = await sendToN8N(data, 'pending');
            
            if (sendResult.success) {
                addLog('success', 'PIX PENDING enviado - ' + orderCode);
            } else {
                addLog('error', 'ERRO enviar PIX PENDING - ' + orderCode);
            }
            
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
        
        console.log('📊 Estado atual:');
        console.log('- PIX pendentes:', pendingPixOrders.size);
        console.log('- Compras monitoradas:', leadPurchases.size);
        console.log('- Respostas registradas:', leadResponses.size);
        console.log('=== FIM DEBUG PERFECT PAY ===\n');
        
        res.status(200).json({ 
            success: true, 
            order_code: orderCode,
            status: status,
            phone: customerPhone
        });
        
    } catch (error) {
        console.error('❌ Erro no Perfect Pay:', error);
        addLog('error', 'ERRO webhook Perfect: ' + error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Função para enviar para N8N - CORRIGIDA
async function sendToN8N(data, eventType, useWhatsAppWebhook = false) {
    try {
        console.log('\n🔧 === DEBUG FUNÇÃO sendToN8N ===');
        console.log('📥 Parâmetros recebidos:', {
            eventType,
            useWhatsAppWebhook,
            hasData: !!data
        });
        
        const webhookUrl = useWhatsAppWebhook ? N8N_WHATSAPP_URL : N8N_WEBHOOK_URL;
        
        console.log('🎯 URL selecionada:', webhookUrl);
        console.log('🔧 N8N_WEBHOOK_URL:', N8N_WEBHOOK_URL);
        console.log('📱 N8N_WHATSAPP_URL:', N8N_WHATSAPP_URL);
        
        const payload = {
            ...data,
            event_type: eventType,
            processed_at: new Date().toISOString(),
            system_info: {
                source: 'perfect-webhook-system-v2',
                version: '2.1'
            }
        };
        
        console.log('📦 Payload preparado:', JSON.stringify(payload, null, 2));
        console.log(`📤 INICIANDO ENVIO para N8N - Tipo: ${eventType}`);
        
        addLog('info', 'INICIANDO envio para N8N - Tipo: ' + eventType);
        
        const response = await axios.post(webhookUrl, payload, {
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Perfect-Webhook-System-v2/2.1'
            },
            timeout: 15000
        });
        
        console.log(`✅ SUCESSO! Resposta N8N - Status: ${response.status}`);
        console.log('📄 Resposta completa:', response.data);
        addLog('webhook_sent', 'SUCESSO - Enviado para N8N - Tipo: ' + eventType + ' | Status: ' + response.status);
        
        console.log('=== FIM DEBUG sendToN8N ===\n');
        
        return { success: true, status: response.status, data: response.data };
        
    } catch (error) {
        console.log('\n❌ === ERRO NA FUNÇÃO sendToN8N ===');
        console.log('🔥 Erro completo:', error);
        console.log('📊 Error message:', error.message);
        console.log('🌐 Error response:', error.response?.data);
        console.log('📡 Error status:', error.response?.status);
        console.log('🔗 URL que falhou:', useWhatsAppWebhook ? N8N_WHATSAPP_URL : N8N_WEBHOOK_URL);
        
        const errorMessage = error.response ? 
            'HTTP ' + error.response.status + ': ' + error.response.statusText : 
            error.message;
            
        console.error(`❌ Erro ao enviar para N8N:`, errorMessage);
        addLog('error', 'ERRO enviar N8N - Tipo: ' + eventType + ' | Erro: ' + errorMessage);
        
        console.log('=== FIM ERRO sendToN8N ===\n');
        
        return { success: false, error: errorMessage };
    }
}

// NOVO: Endpoint debug completo
app.get('/debug', (req, res) => {
    const debugInfo = {
        timestamp: new Date().toISOString(),
        system_status: 'online',
        
        leadResponses: {
            count: leadResponses.size,
            data: Array.from(leadResponses.entries()).map(([phone, data]) => ({
                phone,
                message: data.message?.substring(0, 50) + '...',
                timestamp: new Date(data.timestamp).toISOString(),
                age_minutes: Math.round((Date.now() - data.timestamp) / 60000)
            }))
        },
        
        leadPurchases: {
            count: leadPurchases.size,
            data: Array.from(leadPurchases.entries()).map(([phone, data]) => ({
                phone,
                orderCode: data.orderCode,
                customerName: data.customerName,
                timestamp: new Date(data.timestamp).toISOString(),
                age_minutes: Math.round((Date.now() - data.timestamp) / 60000)
            }))
        },
        
        pendingPixOrders: {
            count: pendingPixOrders.size,
            data: Array.from(pendingPixOrders.entries()).map(([code, data]) => ({
                orderCode: code,
                customerPhone: data.customer_phone,
                customerName: data.customer_name,
                timestamp: data.timestamp.toISOString(),
                age_minutes: Math.round((Date.now() - data.timestamp.getTime()) / 60000)
            }))
        },
        
        recent_logs: systemLogs.slice(-20),
        
        stats: {
            total_webhooks: systemLogs.filter(l => l.type === 'webhook_received').length,
            responses_detected: systemLogs.filter(l => l.message.includes('RESPOSTA DETECTADA')).length,
            continuations_sent: systemLogs.filter(l => l.message.includes('FLUXO CONTINUADO')).length,
            errors: systemLogs.filter(l => l.type === 'error').length
        },
        
        config: {
            n8n_webhook_url: N8N_WEBHOOK_URL,
            pix_timeout_minutes: PIX_TIMEOUT / 60000,
            log_retention_hours: LOG_RETENTION_TIME / 3600000
        }
    };
    
    res.json(debugInfo);
});

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

// Interface atualizada com debug
app.get('/', (req, res) => {
    const htmlContent = '<!DOCTYPE html>' +
        '<html>' +
        '<head>' +
        '<title>Webhook Vendas v2.1 - Debug Total</title>' +
        '<meta charset="utf-8">' +
        '<style>' +
        'body { font-family: Arial, sans-serif; padding: 20px; background: #f5f5f5; }' +
        '.container { max-width: 800px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; }' +
        'h1 { color: #333; text-align: center; }' +
        '.status { background: #4CAF50; color: white; padding: 15px; border-radius: 5px; margin: 20px 0; text-align: center; }' +
        '.debug-status { background: #ff9800; color: white; padding: 10px; border-radius: 5px; margin: 10px 0; text-align: center; font-size: 14px; }' +
        '.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin: 20px 0; }' +
        '.stat-card { background: #f8f9fa; padding: 20px; border-radius: 5px; text-align: center; border-left: 4px solid #007bff; }' +
        '.stat-value { font-size: 2em; font-weight: bold; color: #007bff; }' +
        '.stat-label { color: #666; font-size: 0.9em; }' +
        '.btn { background: #007bff; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; margin: 5px; }' +
        '.btn:hover { background: #0056b3; }' +
        '.btn-debug { background: #dc3545; }' +
        '.btn-debug:hover { background: #c82333; }' +
        '.config { background: #f8f9fa; padding: 20px; border-radius: 5px; margin: 20px 0; }' +
        '.input-group { display: flex; gap: 10px; margin: 10px 0; }' +
        '.form-input { flex: 1; padding: 10px; border: 1px solid #ddd; border-radius: 5px; }' +
        '</style>' +
        '</head>' +
        '<body>' +
        '<div class="container">' +
        '<h1>🚀 Webhook Vendas v2.1 - DEBUG TOTAL</h1>' +
        '<div class="status">' +
        '<strong>Sistema Online</strong> - Monitorando vendas e respostas WhatsApp' +
        '</div>' +
        '<div class="debug-status">' +
        '<strong>🔍 MODO DEBUG ATIVO</strong> - Capturando TODOS os formatos da Evolution API' +
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
        '<button class="btn btn-debug" onclick="viewDebug()">🔍 Debug Completo</button>' +
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
        '<p><strong>Debug:</strong> /debug</p>' +
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
        'function viewDebug() {' +
        'fetch("/debug")' +
        '.then(r => r.json())' +
        '.then(data => {' +
        'const info = "ESTADO ATUAL:\\n" +' +
        '"- Respostas: " + data.leadResponses.count + "\\n" +' +
        '"- Compras: " + data.leadPurchases.count + "\\n" +' +
        '"- PIX Pendentes: " + data.pendingPixOrders.count + "\\n\\n" +' +
        '"ESTATÍSTICAS:\\n" +' +
        '"- Webhooks: " + data.stats.total_webhooks + "\\n" +' +
        '"- Respostas detectadas: " + data.stats.responses_detected + "\\n" +' +
        '"- Continuações enviadas: " + data.stats.continuations_sent + "\\n" +' +
        '"- Erros: " + data.stats.errors;' +
        'alert(info);' +
        'console.log("Debug completo:", data);' +
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
    addLog('info', 'Debug: /debug');
    addLog('info', 'Interface: /');
    console.log('🚀 Servidor rodando na porta ' + PORT);
    console.log('📱 Webhook WhatsApp: /webhook/whatsapp-response');
    console.log('💰 Webhook Perfect Pay: /webhook/perfect');
    console.log('🔍 Debug completo: /debug');
    console.log('📊 Interface: /');
});
