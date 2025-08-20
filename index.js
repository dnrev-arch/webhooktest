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

// Função para normalizar telefones - VERSÃO CORRIGIDA
function normalizePhone(phone) {
    if (!phone) return '';
    
    // Remove todos os caracteres não numéricos
    let normalized = phone.toString().replace(/\D/g, '');
    
    console.log('📱 Normalizando telefone:', {
        original: phone,
        apenas_numeros: normalized
    });
    
    // Lista completa de DDDs brasileiros
    const ddds_brasileiros = [
        '11','12','13','14','15','16','17','18','19', // SP
        '21','22','24','27','28', // RJ/ES
        '31','32','33','34','35','37','38', // MG
        '41','42','43','44','45','46', // PR
        '47','48','49', // SC
        '51','53','54','55', // RS
        '61','62','63','64','65','66','67', // Centro-Oeste
        '68','69', // Norte
        '71','73','74','75','77','79', // BA/SE
        '81','82','83','84','85','86','87','88','89', // Nordeste
        '91','92','93','94','95','96','97','98','99' // Norte/MA
    ];
    
    // CORREÇÃO PRINCIPAL: Se tem DDI 57 com DDD brasileiro (bug do sistema)
    if (normalized.startsWith('57') && normalized.length >= 12) {
        // Verifica os próximos 2 dígitos (possível DDD)
        const possivelDDD = normalized.substring(2, 4);
        
        if (ddds_brasileiros.includes(possivelDDD)) {
            console.log('🔧 Detectado DDI 57 com DDD brasileiro - corrigindo...');
            
            // Remove DDI 57 errado
            let semDDI = normalized.substring(2);
            
            // Se ficou com 11 dígitos e começa com 0, remove o 0
            if (semDDI.length === 11 && semDDI[0] === '0') {
                semDDI = semDDI.substring(1);
                console.log('📱 Removido zero extra:', semDDI);
            }
            
            // Adiciona DDI 55 correto
            normalized = '55' + semDDI;
            console.log('✅ Corrigido DDI 57→55:', normalized);
            return normalized;
        }
    }
    
    // Se tem 13 dígitos e começa com 55 (Brasil) - MANTER COMO ESTÁ
    if (normalized.length === 13 && normalized.startsWith('55')) {
        console.log('✅ Telefone brasileiro correto - mantido:', normalized);
        return normalized;
    }
    
    // Se tem 11 dígitos (celular brasileiro sem DDI)
    if (normalized.length === 11) {
        const ddd = normalized.substring(0, 2);
        if (ddds_brasileiros.includes(ddd)) {
            // Adiciona DDI 55
            normalized = '55' + normalized;
            console.log('📱 Adicionado DDI 55:', normalized);
            return normalized;
        }
    }
    
    // Se tem 10 dígitos (telefone antigo sem 9)
    if (normalized.length === 10) {
        const ddd = normalized.substring(0, 2);
        if (ddds_brasileiros.includes(ddd)) {
            // Adiciona 9 e DDI
            const numero = normalized.substring(2);
            normalized = '55' + ddd + '9' + numero;
            console.log('📱 Adicionado 9 e DDI:', normalized);
            return normalized;
        }
    }
    
    // IMPORTANTE: NÃO remover dígitos se não identificamos o padrão
    console.log('📱 Telefone final (sem alterações):', normalized);
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

// WEBHOOK WHATSAPP - VERSÃO CORRIGIDA SEM LOOP
app.post('/webhook/whatsapp-response', async (req, res) => {
    try {
        console.log('\n🔍 === WEBHOOK WHATSAPP INICIADO ===');
        
        // ✅ ANTI-DUPLICATA IMEDIATO - Verificar se já processamos este webhook
        const requestId = req.body.key?.id || JSON.stringify(req.body).substring(0, 100);
        const duplicateKey = 'wh_dup_' + requestId;
        
        if (leadResponses.has(duplicateKey)) {
            console.log('🛑 WEBHOOK DUPLICADO - Ignorando para evitar loop');
            return res.status(200).json({ success: true, duplicated: true });
        }
        
        // Marcar como processado por 5 minutos
        leadResponses.set(duplicateKey, { timestamp: Date.now() });
        
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
            
            // SEMPRE continuar fluxo quando lead responder
            console.log('🎯 Lead respondeu - continuando fluxo automaticamente');

            // Buscar dados do PIX salvos para este telefone
            let pixDataSalvo = leadPurchases.get(normalizedPhone);
            console.log('💰 Dados PIX encontrados para', normalizedPhone, ':', pixDataSalvo ? 'SIM' : 'NÃO');

            // Preparar dados para continuação do fluxo COM DADOS DO PIX
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
                    source: 'perfect-webhook-system-v2',
                    version: '2.1'
                },
                // INCLUIR DADOS DO PIX SE EXISTIREM
                ...(pixDataSalvo && {
                    billet_url: pixDataSalvo.originalData?.billet_url || '',
                    billet_number: pixDataSalvo.originalData?.billet_number || '',
                    sale_amount: pixDataSalvo.amount || 0,
                    sale_status_enum_key: pixDataSalvo.originalData?.sale_status_enum_key || 'pending',
                    customer: pixDataSalvo.originalData?.customer || {},
                    order_code: pixDataSalvo.orderCode || ''
                })
            };

            console.log('📤 Payload com PIX incluído:', 
                pixDataSalvo ? 'URL: ' + (pixDataSalvo.originalData?.billet_url || 'N/A') : 'Sem dados PIX'
            );

            console.log('🚀 Enviando continuação para N8N...');
            const sendResult = await sendToN8N(continuationPayload, 'lead_active_continuation', true);

            if (sendResult.success) {
                addLog('success', `✅ FLUXO CONTINUADO COM SUCESSO - Lead: ${normalizedPhone}`);
                console.log('🎯 FLUXO CONTINUADO COM SUCESSO!');
            } else {
                addLog('error', `❌ ERRO ao continuar fluxo - Lead: ${normalizedPhone} | Erro: ${sendResult.error}`);
                console.log('❌ ERRO ao enviar continuação para N8N:', sendResult.error);
            }
        } else {
            console.log('❌ Não foi possível extrair telefone ou mensagem');
            addLog('info', '❌ Webhook WhatsApp: dados insuficientes para processar');
            
            // DEBUG: Mostrar estrutura recebida quando falha
            console.log('📊 Estrutura de dados recebida:', Object.keys(data));
            addLog('info', '📊 Estrutura recebida: ' + Object.keys(data).join(', '));
        }
        
        console.log('=== FIM WEBHOOK WHATSAPP ===\n');
        
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

// Webhook Perfect Pay - VERSÃO CORRIGIDA
app.post('/webhook/perfect', async (req, res) => {
    try {
        console.log('\n💰 === WEBHOOK PERFECT PAY INICIADO ===');
        
        const data = req.body;
        const orderCode = data.code;
        const status = data.sale_status_enum_key;
        const customerName = data.customer?.full_name || 'N/A';
        const amount = data.sale_amount || 0;
        
        // Extrair telefone com debug detalhado
        const phoneOptions = {
            concatenated: (data.customer?.phone_extension || '') + 
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
                console.log('🔍 TELEFONE SALVO PERFECT PAY:', customerPhone);
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
                console.log('🔍 TELEFONE SALVO PERFECT PAY:', customerPhone);
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
        console.log('=== FIM WEBHOOK PERFECT PAY ===\n');
        
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

// ✅✅✅ FUNÇÃO sendToN8N CORRIGIDA - SEM RETRY AUTOMÁTICO
async function sendToN8N(data, eventType, useWhatsAppWebhook = false) {
    try {
        console.log('\n🔧 === ENVIO PARA N8N INICIADO ===');
        console.log('📥 Event Type:', eventType);
        console.log('📱 WhatsApp Webhook:', useWhatsAppWebhook);
        
        const webhookUrl = useWhatsAppWebhook ? N8N_WHATSAPP_URL : N8N_WEBHOOK_URL;
        
        console.log('🎯 URL selecionada:', webhookUrl);
        
        const payload = {
            ...data,
            event_type: eventType,
            processed_at: new Date().toISOString(),
            system_info: {
                source: 'perfect-webhook-system-v2',
                version: '2.1'
            }
        };
        
        console.log('📦 Payload preparado (resumido):', {
            event_type: payload.event_type,
            has_phone: !!payload.lead_interaction?.phone,
            has_pix_data: !!(payload.billet_url || payload.billet_number)
        });
        
        console.log(`📤 ENVIANDO para N8N - SEM RETRY AUTOMÁTICO`);
        
        addLog('info', 'ENVIANDO para N8N - Tipo: ' + eventType + ' - SEM RETRY');
        
        // ⚠️⚠️⚠️ ENVIO ÚNICO - SEM TENTATIVAS DE RETRY
        const response = await axios.post(webhookUrl, payload, {
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Perfect-Webhook-System-v2/2.1'
            },
            timeout: 10000 // ⏰ Timeout de 10 segundos
        });
        
        console.log(`✅ SUCESSO! Resposta N8N - Status: ${response.status}`);
        addLog('webhook_sent', 'SUCESSO - Enviado para N8N - Tipo: ' + eventType + ' | Status: ' + response.status);
        
        console.log('=== FIM ENVIO N8N ===\n');
        
        return { success: true, status: response.status, data: response.data };
        
    } catch (error) {
        console.log('\n❌ === ERRO NO ENVIO PARA N8N ===');
        console.log('🔥 Erro:', error.message);
        console.log('🔗 URL:', webhookUrl);
        console.log('📊 Detalhes:', error.response?.status, error.response?.statusText);
        
        // ⚠️ APENAS LOGAR O ERRO - NÃO TENTAR NOVAMENTE
        const errorMessage = error.response ? 
            'HTTP ' + error.response.status + ': ' + error.response.statusText : 
            error.message;
            
        console.error('❌ Erro único - NÃO tentando novamente');
        addLog('error', 'ERRO enviar N8N - Tipo: ' + eventType + ' | Erro: ' + errorMessage + ' | SEM RETRY');
        
        console.log('=== FIM ERRO ENVIO ===\n');
        
        return { 
            success: false, 
            error: errorMessage,
            no_retry: true // 🚫 FLAG CRÍTICA: NÃO RETENTAR
        };
    }
}

// Endpoints de debug e status (mantidos iguais)
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
    const htmlContent = `<!DOCTYPE html>
<html>
<head>
<title>Webhook Vendas v2.1 - SEM LOOP</title>
<meta charset="utf-8">
<style>
body { font-family: Arial, sans-serif; padding: 20px; background: #f5f5f5; }
.container { max-width: 800px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; }
h1 { color: #333; text-align: center; }
.status { background: #4CAF50; color: white; padding: 15px; border-radius: 5px; margin: 20px 0; text-align: center; }
.debug-status { background: #ff9800; color: white; padding: 10px; border-radius: 5px; margin: 10px 0; text-align: center; font-size: 14px; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin: 20px 0; }
.stat-card { background: #f8f9fa; padding: 20px; border-radius: 5px; text-align: center; border-left: 4px solid #007bff; }
.stat-value { font-size: 2em; font-weight: bold; color: #007bff; }
.stat-label { color: #666; font-size: 0.9em; }
.btn { background: #007bff; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; margin: 5px; }
.btn:hover { background: #0056b3; }
.btn-debug { background: #dc3545; }
.btn-debug:hover { background: #c82333; }
.config { background: #f8f9fa; padding: 20px; border-radius: 5px; margin: 20px 0; }
.input-group { display: flex; gap: 10px; margin: 10px 0; }
.form-input { flex: 1; padding: 10px; border: 1px solid #ddd; border-radius: 5px; }
</style>
</head>
<body>
<div class="container">
<h1>🚀 Webhook Vendas v2.1 - SEM LOOP</h1>
<div class="status">
<strong>✅ Sistema Corrigido - Sem Loop</strong>
</div>
<div class="debug-status">
<strong>🔧 MODIFICAÇÕES APLICADAS:</strong> Anti-duplicata + Sem Retry Automático
</div>
<div class="stats">
<div class="stat-card">
<div class="stat-value" id="pending-count">0</div>
<div class="stat-label">PIX Pendentes</div>
</div>
<div class="stat-card">
<div class="stat-value" id="leads-responded">0</div>
<div class="stat-label">Leads Responderam</div>
</div>
<div class="stat-card">
<div class="stat-value" id="leads-waiting">0</div>
<div class="stat-label">Aguardando Resposta</div>
</div>
<div class="stat-card">
<div class="stat-value" id="total-received">0</div>
<div class="stat-label">Total Recebidos</div>
</div>
</div>
<div style="text-align: center; margin: 20px 0;">
<button class="btn" onclick="refreshStatus()">🔄 Atualizar</button>
<button class="btn" onclick="viewLeads()">👥 Ver Leads</button>
<button class="btn btn-debug" onclick="viewDebug()">🔍 Debug Completo</button>
</div>
<div class="config">
<h3>⚙️ Configuração N8N</h3>
<div class="input-group">
<input type="text" class="form-input" id="n8n-url" placeholder="URL do N8N webhook..." value="${N8N_WEBHOOK_URL}" />
<button class="btn" onclick="saveUrl()">💾 Salvar</button>
</div>
</div>
<div class="config">
<h3>📍 Endpoints Disponíveis</h3>
<p><strong>Perfect Pay:</strong> /webhook/perfect</p>
<p><strong>WhatsApp:</strong> /webhook/whatsapp-response</p>
<p><strong>Debug:</strong> /debug</p>
</div>
</div>
<script>
function refreshStatus() {
fetch("/status")
.then(r => r.json())
.then(data => {
document.getElementById("pending-count").textContent = data.pending_pix_orders;
document.getElementById("leads-responded").textContent = data.lead_interaction_stats.responded;
document.getElementById("leads-waiting").textContent = data.lead_interaction_stats.waiting_response;
document.getElementById("total-received").textContent = data.statistics.total_webhooks_received;
});
}
function viewLeads() {
fetch("/leads-status")
.then(r => r.json())
.then(data => {
alert("Leads Responderam: " + data.leads_responded + "\\nAguardando: " + data.leads_waiting_response);
});
}
function viewDebug() {
fetch("/debug")
.then(r => r.json())
.then(data => {
const info = "ESTADO ATUAL:\\n" +
"- Respostas: " + data.leadResponses.count + "\\n" +
"- Compras: " + data.leadPurchases.count + "\\n" +
"- PIX Pendentes: " + data.pendingPixOrders.count + "\\n\\n" +
"ESTATÍSTICAS:\\n" +
"- Webhooks: " + data.stats.total_webhooks + "\\n" +
"- Respostas detectadas: " + data.stats.responses_detected + "\\n" +
"- Continuações enviadas: " + data.stats.continuations_sent + "\\n" +
"- Erros: " + data.stats.errors;
alert(info);
console.log("Debug completo:", data);
});
}
function saveUrl() {
const url = document.getElementById("n8n-url").value;
fetch("/config/n8n-url", {
method: "POST",
headers: {"Content-Type": "application/json"},
body: JSON.stringify({url: url})
})
.then(r => r.json())
.then(data => {
alert(data.message);
refreshStatus();
});
}
setInterval(refreshStatus, 10000);
refreshStatus();
</script>
</body>
</html>`;
    
    res.send(htmlContent);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    addLog('info', 'Sistema v2.1 CORRIGIDO iniciado na porta ' + PORT);
    addLog('info', '✅ Anti-loop implementado - SEM retry automático');
    console.log('🚀 Servidor CORRIGIDO rodando na porta ' + PORT);
    console.log('📱 Webhook WhatsApp: /webhook/whatsapp-response');
    console.log('💰 Webhook Perfect Pay: /webhook/perfect');
    console.log('🔍 Debug completo: /debug');
    console.log('📊 Interface: /');
});
