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

// WEBHOOK WHATSAPP - VERSÃO CORRIGIDA PARA N8N
app.post('/webhook/whatsapp-response', async (req, res) => {
    try {
        console.log('\n🔍 === WEBHOOK WHATSAPP RESPOSTA ===');
        console.log('Body completo:', JSON.stringify(req.body, null, 2));
        
        const data = req.body;
        
        // REGISTRAR TUDO que chega - para debug
        addLog('info', '📱 WEBHOOK WHATSAPP RECEBIDO: ' + JSON.stringify(data).substring(0, 200) + '...');
        
        // Extrair telefone
        let phone = null;
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
        
        // Extrair mensagem
        let message = null;
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
                
                // ✨ NOVA VERSÃO: Preparar dados para continuação do fluxo N8N
                const reactivationPayload = {
                    event_type: 'lead_active_continuation', // 🔑 CHAVE PARA O N8N
                    customer_response: {
                        message: message,
                        phone: normalizedPhone,
                        response_time: new Date().toISOString(),
                        session_id: purchaseData.orderCode
                    },
                    original_order: {
                        code: purchaseData.orderCode,
                        customer_name: purchaseData.customerName,
                        amount: purchaseData.amount,
                        phone: normalizedPhone,
                        plan: {
                            code: purchaseData.originalData?.plan?.code || 'PPLQOMOVD'
                        }
                    },
                    session_data: purchaseData,
                    // Manter compatibilidade com versão anterior
                    lead_interaction: {
                        responded: true,
                        response_message: message,
                        response_time: new Date().toISOString(),
                        phone: normalizedPhone,
                        customer_name: purchaseData.customerName
                    },
                    processed_at: new Date().toISOString(),
                    system_info: {
                        source: 'perfect-webhook-system-v2',
                        version: '2.1',
                        action: 'flow_reactivation'
                    }
                };
                
                console.log('📤 ENVIANDO REATIVAÇÃO PARA N8N:', JSON.stringify(reactivationPayload, null, 2));
                
                const sendResult = await sendToN8N(reactivationPayload, 'lead_active_continuation');
                
                if (sendResult.success) {
                    addLog('success', `✅ FLUXO REATIVADO COM SUCESSO - Lead: ${normalizedPhone} | Pedido: ${purchaseData.orderCode}`);
                    console.log('🎯 FLUXO REATIVADO COM SUCESSO!');
                } else {
                    addLog('error', `❌ ERRO ao reativar fluxo - Lead: ${normalizedPhone} | Erro: ${sendResult.error}`);
                    console.log('❌ ERRO ao enviar reativação para N8N:', sendResult.error);
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
            totalPurchases: leadPurchases.size,
            sessionFound: phone ? leadPurchases.has(normalizePhone(phone)) : false
        });
        
    } catch (error) {
        console.error('❌ Erro no webhook WhatsApp:', error);
        addLog('error', 'ERRO resposta WhatsApp: ' + error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Webhook Perfect Pay - VERSÃO CORRIGIDA COM ENVIO PARA N8N
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
            
            // ✨ MELHORADO: Registrar compra para monitoramento de resposta
            if (customerPhone && customerPhone.length >= 10) {
                leadPurchases.set(customerPhone, {
                    timestamp: Date.now(),
                    originalData: data,
                    orderCode: orderCode,
                    customerName: customerName,
                    amount: amount,
                    phone: customerPhone,
                    sessionId: orderCode + '_' + Date.now() // ID único da sessão
                });
                
                addLog('info', 'SESSÃO CRIADA para monitoramento - Tel: ' + customerPhone + ' | Pedido: ' + orderCode);
                console.log('📝 Sessão de lead criada:', customerPhone);
            }
            
            // 🔥 CORREÇÃO CRUCIAL: Enviar PIX GERADO para N8N
            const sendResult = await sendToN8N(data, 'pending');
            
            if (sendResult.success) {
                addLog('success', 'PIX GERADO enviado para N8N - ' + orderCode);
                console.log('✅ PIX GERADO enviado para N8N com sucesso!');
            } else {
                addLog('error', 'ERRO enviar PIX GERADO - ' + orderCode);
                console.log('❌ ERRO ao enviar PIX GERADO para N8N:', sendResult.error);
            }
            
            // Configurar timeout do PIX
            if (pendingPixOrders.has(orderCode)) {
                clearTimeout(pendingPixOrders.get(orderCode).timeout);
            }
            
            const timeout = setTimeout(async () => {
                addLog('timeout', 'TIMEOUT PIX - ' + orderCode);
                pendingPixOrders.delete(orderCode);
                
                const timeoutResult = await sendToN8N(data, 'pix_timeout');
                
                if (timeoutResult.success) {
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
        
        console.log(`📤 Enviando para N8N - Tipo: ${eventType}`);
        console.log('URL N8N:', N8N_WEBHOOK_URL);
        
        addLog('info', 'Enviando para N8N - Tipo: ' + eventType);
        
        const response = await axios.post(N8N_WEBHOOK_URL, payload, {
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Perfect-Webhook-System-v2/2.1'
            },
            timeout: 15000
        });
        
        console.log(`✅ Resposta N8N - Status: ${response.status}`);
        addLog('webhook_sent', 'Enviado para N8N - Tipo: ' + eventType + ' | Status: ' + response.status);
        
        return { success: true, status: response.status, data: response.data };
        
    } catch (error) {
        const errorMessage = error.response ? 
            'HTTP ' + error.response.status + ': ' + error.response.statusText : 
            error.message;
            
        console.error(`❌ Erro ao enviar para N8N:`, errorMessage);
        addLog('error', 'ERRO enviar N8N - Tipo: ' + eventType + ' | Erro: ' + errorMessage);
        
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
            continuations_sent: systemLogs.filter(l => l.message.includes('FLUXO REATIVADO')).length,
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

// Interface web simplificada (removendo HTML complexo que causava erro)
app.get('/', (req, res) => {
    res.json({
        status: 'online',
        message: 'Webhook Vendas v2.1 - Sistema Funcionando',
        endpoints: {
            perfect_pay: '/webhook/perfect',
            whatsapp: '/webhook/whatsapp-response',
            debug: '/debug',
            health: '/health',
            status: '/status'
        },
        stats: {
            pending_orders: pendingPixOrders.size,
            lead_responses: leadResponses.size,
            lead_purchases: leadPurchases.size
        },
        config: {
            n8n_url: N8N_WEBHOOK_URL
        }
    });
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
