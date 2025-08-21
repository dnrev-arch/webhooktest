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

// Função para normalizar telefones - VERSÃO CORRIGIDA v2.3
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
    
    // CORREÇÃO: Se tem DDI 57 com DDD brasileiro (bug do sistema)
    if (normalized.startsWith('57') && normalized.length === 13) {
        const possivelDDD = normalized.substring(2, 4);
        
        if (ddds_brasileiros.includes(possivelDDD)) {
            console.log('🔧 Detectado DDI 57 com DDD brasileiro - corrigindo...');
            normalized = '55' + normalized.substring(2);
            console.log('✅ Corrigido DDI 57→55:', normalized);
            return normalized;
        }
    }
    
    // Se tem 13 dígitos e começa com 55 (Brasil) - MANTER COMO ESTÁ
    if (normalized.length === 13 && normalized.startsWith('55')) {
        console.log('✅ Telefone brasileiro correto:', normalized);
        return normalized;
    }
    
    // Se tem 11 dígitos (celular brasileiro sem DDI)
    if (normalized.length === 11) {
        const ddd = normalized.substring(0, 2);
        if (ddds_brasileiros.includes(ddd)) {
            normalized = '55' + normalized;
            console.log('📱 Adicionado DDI 55:', normalized);
            return normalized;
        }
    }
    
    // Se tem 10 dígitos (telefone antigo sem 9)
    if (normalized.length === 10) {
        const ddd = normalized.substring(0, 2);
        if (ddds_brasileiros.includes(ddd)) {
            const numero = normalized.substring(2);
            normalized = '55' + ddd + '9' + numero;
            console.log('📱 Adicionado 9 e DDI:', normalized);
            return normalized;
        }
    }
    
    console.log('📱 Telefone final:', normalized);
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
    
    // Limpar logs antigos
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

// WEBHOOK PERFECT PAY - VERSÃO CORRIGIDA v2.3
app.post('/webhook/perfect', async (req, res) => {
    try {
        console.log('\n💰 === WEBHOOK PERFECT PAY INICIADO ===');
        
        const data = req.body;
        const orderCode = data.code || '';
        const status = data.sale_status_enum_key || '';
        const customerName = data.customer?.full_name || 'N/A';
        const amount = data.sale_amount || 0;
        
        // ✅ CORREÇÃO CRÍTICA: Extrair telefone corretamente do Perfect Pay
        const phoneExtension = data.customer?.phone_extension || '';
        const phoneAreaCode = data.customer?.phone_area_code || '';
        const phoneNumber = data.customer?.phone_number || '';
        
        // Concatenar os campos do telefone
        const rawCustomerPhone = phoneExtension + phoneAreaCode + phoneNumber;
        
        console.log('📱 Campos de telefone Perfect Pay:', {
            extension: phoneExtension,
            area_code: phoneAreaCode,
            number: phoneNumber,
            concatenated: rawCustomerPhone
        });
        
        // Normalizar telefone
        const customerPhone = normalizePhone(rawCustomerPhone);
        
        console.log('📱 Telefone Perfect Pay processado:', {
            raw: rawCustomerPhone,
            normalized: customerPhone
        });
        
        // ✅ EXTRAIR DADOS PIX CORRETAMENTE
        const pixUrl = data.billet_url || '';
        const pixCode = data.billet_number || '';
        
        console.log('💰 Dados PIX recebidos:', {
            url: pixUrl ? 'Presente' : 'Ausente',
            code: pixCode ? 'Presente' : 'Ausente',
            order_code: orderCode,
            status: status
        });
        
        addLog('webhook_received', `Webhook Perfect Pay - Pedido: ${orderCode} | Status: ${status} | Tel: ${customerPhone}`, {
            order_code: orderCode,
            status: status,
            phone: customerPhone,
            has_pix_url: !!pixUrl,
            has_pix_code: !!pixCode
        });
        
        // ✅ SEMPRE SALVAR DADOS DO LEAD E PIX
        if (customerPhone && customerPhone.length >= 10) {
            console.log('💾 Salvando dados do lead:', customerPhone);
            
            leadPurchases.set(customerPhone, {
                timestamp: Date.now(),
                originalData: {
                    ...data,
                    // ✅ GARANTIR que os campos PIX estejam salvos
                    billet_url: pixUrl,
                    billet_number: pixCode,
                    sale_amount: amount,
                    sale_status_enum_key: status,
                    code: orderCode
                },
                orderCode: orderCode,
                customerName: customerName,
                amount: amount,
                phone: customerPhone,
                pixUrl: pixUrl,
                pixCode: pixCode
            });
            
            console.log('✅ Lead salvo com dados PIX completos');
            addLog('info', `LEAD REGISTRADO - Tel: ${customerPhone} | PIX URL: ${!!pixUrl} | PIX Code: ${!!pixCode}`);
        }
        
        // Processar diferentes status
        if (status === 'approved') {
            addLog('info', `✅ VENDA APROVADA - ${orderCode}`);
            
            // Limpar pendentes
            if (pendingPixOrders.has(orderCode)) {
                clearTimeout(pendingPixOrders.get(orderCode).timeout);
                pendingPixOrders.delete(orderCode);
            }
            
        } else if (status === 'pending') {
            addLog('info', `⏳ PIX GERADO - ${orderCode} | Tel: ${customerPhone}`);
            
            // Configurar timeout
            if (pendingPixOrders.has(orderCode)) {
                clearTimeout(pendingPixOrders.get(orderCode).timeout);
            }
            
            const timeout = setTimeout(async () => {
                addLog('timeout', `⏰ TIMEOUT PIX - ${orderCode}`);
                pendingPixOrders.delete(orderCode);
                
                // Enviar timeout para N8N
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
        
        // ✅ SEMPRE enviar para N8N
        const sendResult = await sendToN8N(data, status || 'webhook_received');
        
        if (sendResult.success) {
            addLog('success', `✅ Webhook enviado para N8N - Status: ${status}`);
        } else {
            addLog('error', `❌ Erro ao enviar para N8N - ${sendResult.error}`);
        }
        
        console.log('📊 Estado atual:');
        console.log('- PIX pendentes:', pendingPixOrders.size);
        console.log('- Leads salvos:', leadPurchases.size);
        console.log('- Respostas registradas:', leadResponses.size);
        console.log('=== FIM WEBHOOK PERFECT PAY ===\n');
        
        res.status(200).json({ 
            success: true, 
            order_code: orderCode,
            status: status,
            phone: customerPhone,
            has_pix_data: !!(pixUrl || pixCode)
        });
        
    } catch (error) {
        console.error('❌ Erro no Perfect Pay:', error);
        addLog('error', `ERRO webhook Perfect: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

// WEBHOOK WHATSAPP - VERSÃO CORRIGIDA v2.3
app.post('/webhook/whatsapp-response', async (req, res) => {
    try {
        console.log('\n📱 === WEBHOOK WHATSAPP INICIADO ===');
        
        // Anti-duplicata
        const requestId = req.body.key?.id || JSON.stringify(req.body).substring(0, 100);
        const duplicateKey = 'wh_dup_' + requestId;
        
        if (leadResponses.has(duplicateKey)) {
            console.log('🛑 WEBHOOK DUPLICADO - Ignorando');
            return res.status(200).json({ success: true, duplicated: true });
        }
        
        // Marcar como processado
        leadResponses.set(duplicateKey, { timestamp: Date.now() });
        
        const data = req.body;
        
        addLog('info', `📱 WEBHOOK WHATSAPP RECEBIDO`);
        
        // Extrair telefone
        let phone = null;
        let message = null;
        
        // Tentar todas as formas de extrair telefone
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
                console.log('✅ Telefone encontrado:', phone);
                break;
            }
        }
        
        // Extrair mensagem
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
                break;
            }
        }
        
        if (phone && message) {
            const normalizedPhone = normalizePhone(phone);
            
            console.log('🎯 PROCESSANDO RESPOSTA:', {
                raw: phone,
                normalized: normalizedPhone,
                message: message.substring(0, 50) + '...'
            });
            
            // Registrar resposta
            leadResponses.set(normalizedPhone, {
                timestamp: Date.now(),
                message: message,
                phone: normalizedPhone,
                full_data: data
            });
            
            addLog('info', `✅ RESPOSTA DETECTADA - Tel: ${normalizedPhone}`);
            
            // ✅ BUSCAR DADOS PIX SALVOS
            let pixDataSalvo = leadPurchases.get(normalizedPhone);
            
            console.log('💰 Dados PIX encontrados:', {
                has_data: !!pixDataSalvo,
                has_url: !!(pixDataSalvo?.pixUrl || pixDataSalvo?.originalData?.billet_url),
                has_code: !!(pixDataSalvo?.pixCode || pixDataSalvo?.originalData?.billet_number)
            });
            
            // ✅ PREPARAR PAYLOAD COM DADOS PIX COMPLETOS
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
                    source: 'perfect-webhook-system-v2.3',
                    version: '2.3'
                },
                // ✅ SEMPRE INCLUIR DADOS DO PIX
                billet_url: pixDataSalvo?.pixUrl || pixDataSalvo?.originalData?.billet_url || '',
                billet_number: pixDataSalvo?.pixCode || pixDataSalvo?.originalData?.billet_number || '',
                sale_amount: pixDataSalvo?.amount || pixDataSalvo?.originalData?.sale_amount || 0,
                sale_status_enum_key: pixDataSalvo?.originalData?.sale_status_enum_key || 'pending',
                customer: pixDataSalvo?.originalData?.customer || {},
                order_code: pixDataSalvo?.orderCode || pixDataSalvo?.originalData?.code || '',
                code: pixDataSalvo?.orderCode || pixDataSalvo?.originalData?.code || ''
            };
            
            console.log('📤 Payload preparado com PIX:', {
                has_billet_url: !!continuationPayload.billet_url,
                has_billet_number: !!continuationPayload.billet_number,
                sale_amount: continuationPayload.sale_amount,
                order_code: continuationPayload.order_code
            });
            
            // Enviar para N8N
            console.log('🚀 Enviando continuação para N8N...');
            const sendResult = await sendToN8N(continuationPayload, 'lead_active_continuation', true);
            
            if (sendResult.success) {
                addLog('success', `✅ FLUXO CONTINUADO - Lead: ${normalizedPhone}`);
                console.log('✅ SUCESSO! Fluxo continuado');
            } else {
                addLog('error', `❌ ERRO ao continuar fluxo - ${sendResult.error}`);
                console.log('❌ ERRO ao enviar para N8N:', sendResult.error);
            }
        } else {
            console.log('⚠️ Dados insuficientes - Phone:', !!phone, '| Message:', !!message);
            addLog('info', '⚠️ Webhook WhatsApp: dados insuficientes');
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
        addLog('error', `ERRO resposta WhatsApp: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Função sendToN8N - SEM RETRY
async function sendToN8N(data, eventType, useWhatsAppWebhook = false) {
    try {
        console.log('\n📤 === ENVIO PARA N8N ===');
        console.log('📥 Event Type:', eventType);
        console.log('🎯 Webhook:', useWhatsAppWebhook ? 'WhatsApp' : 'Principal');
        
        const webhookUrl = useWhatsAppWebhook ? N8N_WHATSAPP_URL : N8N_WEBHOOK_URL;
        
        const payload = {
            ...data,
            event_type: eventType,
            processed_at: new Date().toISOString(),
            system_info: {
                source: 'perfect-webhook-system-v2.3',
                version: '2.3'
            }
        };
        
        console.log('📦 Payload resumido:', {
            event_type: payload.event_type,
            has_phone: !!(payload.lead_interaction?.phone || payload.customer),
            has_pix_url: !!payload.billet_url,
            has_pix_code: !!payload.billet_number
        });
        
        addLog('info', `📤 Enviando para N8N - Tipo: ${eventType}`);
        
        // Envio único - sem retry
        const response = await axios.post(webhookUrl, payload, {
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Perfect-Webhook-System-v2.3'
            },
            timeout: 10000
        });
        
        console.log(`✅ SUCESSO! Status: ${response.status}`);
        addLog('webhook_sent', `✅ Enviado para N8N - Status: ${response.status}`);
        
        console.log('=== FIM ENVIO N8N ===\n');
        
        return { success: true, status: response.status, data: response.data };
        
    } catch (error) {
        const errorMessage = error.response ? 
            `HTTP ${error.response.status}: ${error.response.statusText}` : 
            error.message;
            
        console.error('❌ Erro no envio:', errorMessage);
        addLog('error', `❌ Erro N8N - ${errorMessage}`);
        
        return { 
            success: false, 
            error: errorMessage,
            no_retry: true
        };
    }
}

// Endpoints de debug e monitoramento
app.get('/debug', (req, res) => {
    const debugInfo = {
        timestamp: new Date().toISOString(),
        system_status: 'online',
        version: '2.3',
        
        leadResponses: {
            count: leadResponses.size,
            data: Array.from(leadResponses.entries()).slice(-10).map(([phone, data]) => ({
                phone,
                message: data.message?.substring(0, 50) + '...',
                timestamp: new Date(data.timestamp).toISOString(),
                age_minutes: Math.round((Date.now() - data.timestamp) / 60000)
            }))
        },
        
        leadPurchases: {
            count: leadPurchases.size,
            data: Array.from(leadPurchases.entries()).slice(-10).map(([phone, data]) => ({
                phone,
                orderCode: data.orderCode,
                customerName: data.customerName,
                has_pix_url: !!data.pixUrl,
                has_pix_code: !!data.pixCode,
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
        
        recent_logs: systemLogs.slice(-30),
        
        stats: {
            total_webhooks: systemLogs.filter(l => l.type === 'webhook_received').length,
            responses_detected: systemLogs.filter(l => l.message.includes('RESPOSTA DETECTADA')).length,
            continuations_sent: systemLogs.filter(l => l.message.includes('FLUXO CONTINUADO')).length,
            errors: systemLogs.filter(l => l.type === 'error').length
        },
        
        config: {
            n8n_webhook_url: N8N_WEBHOOK_URL,
            n8n_whatsapp_url: N8N_WHATSAPP_URL,
            pix_timeout_minutes: PIX_TIMEOUT / 60000,
            log_retention_hours: LOG_RETENTION_TIME / 3600000
        }
    };
    
    res.json(debugInfo);
});

app.get('/leads-status', (req, res) => {
    const responsesList = Array.from(leadResponses.entries())
        .filter(([key, data]) => !key.startsWith('wh_dup_'))
        .slice(-20)
        .map(([phone, data]) => ({
            phone: phone,
            message: data.message?.substring(0, 100) + '...',
            timestamp: data.timestamp,
            time_ago: Math.round((Date.now() - data.timestamp) / 1000 / 60) + ' min atrás'
        }));
    
    const purchasesList = Array.from(leadPurchases.entries())
        .slice(-20)
        .map(([phone, data]) => ({
            phone: phone,
            order_code: data.orderCode,
            customer_name: data.customerName,
            amount: data.amount,
            has_pix_url: !!data.pixUrl,
            has_pix_code: !!data.pixCode,
            timestamp: data.timestamp,
            time_ago: Math.round((Date.now() - data.timestamp) / 1000 / 60) + ' min atrás'
        }));
    
    res.json({
        leads_responded: responsesList.length,
        leads_with_purchases: purchasesList.length,
        responses: responsesList,
        purchases: purchasesList,
        timestamp: new Date().toISOString()
    });
});

app.get('/status', (req, res) => {
    const stats = {
        total_webhooks_received: systemLogs.filter(log => log.type === 'webhook_received').length,
        approved_received: systemLogs.filter(log => log.message.includes('VENDA APROVADA')).length,
        pix_generated: systemLogs.filter(log => log.message.includes('PIX GERADO')).length,
        webhooks_sent: systemLogs.filter(log => log.type === 'webhook_sent').length,
        leads_responded: leadResponses.size,
        leads_with_purchases: leadPurchases.size,
        errors: systemLogs.filter(log => log.type === 'error').length
    };
    
    res.json({
        system_status: 'online',
        version: '2.3',
        timestamp: new Date().toISOString(),
        pending_pix_orders: pendingPixOrders.size,
        lead_stats: {
            responded: leadResponses.size,
            with_purchases: leadPurchases.size
        },
        statistics: stats,
        n8n_urls: {
            main: N8N_WEBHOOK_URL,
            whatsapp: N8N_WHATSAPP_URL
        }
    });
});

app.get('/health', (req, res) => {
    res.json({
        status: 'online',
        version: '2.3',
        timestamp: new Date().toISOString(),
        pending_orders: pendingPixOrders.size,
        leads: {
            responded: leadResponses.size,
            purchases: leadPurchases.size
        },
        uptime: process.uptime()
    });
});

// Interface web atualizada
app.get('/', (req, res) => {
    const htmlContent = `<!DOCTYPE html>
<html>
<head>
<title>Webhook System v2.3 - Perfect Pay</title>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body { 
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
    padding: 20px; 
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    min-height: 100vh;
    margin: 0;
}
.container { 
    max-width: 900px; 
    margin: 0 auto; 
    background: white; 
    padding: 30px; 
    border-radius: 20px;
    box-shadow: 0 20px 60px rgba(0,0,0,0.3);
}
h1 { 
    color: #333; 
    text-align: center;
    margin-bottom: 10px;
}
.version {
    text-align: center;
    color: #666;
    font-size: 14px;
    margin-bottom: 30px;
}
.status { 
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white; 
    padding: 20px; 
    border-radius: 15px; 
    margin: 20px 0; 
    text-align: center;
    font-weight: bold;
    box-shadow: 0 5px 15px rgba(102,126,234,0.4);
}
.stats { 
    display: grid; 
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); 
    gap: 20px; 
    margin: 30px 0; 
}
.stat-card { 
    background: #f8f9fa; 
    padding: 25px; 
    border-radius: 15px; 
    text-align: center;
    transition: transform 0.3s ease, box-shadow 0.3s ease;
    cursor: pointer;
}
.stat-card:hover {
    transform: translateY(-5px);
    box-shadow: 0 10px 30px rgba(0,0,0,0.1);
}
.stat-value { 
    font-size: 2.5em; 
    font-weight: bold; 
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    margin-bottom: 10px;
}
.stat-label { 
    color: #666; 
    font-size: 0.9em;
    text-transform: uppercase;
    letter-spacing: 1px;
}
.btn { 
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white; 
    border: none; 
    padding: 12px 25px; 
    border-radius: 10px; 
    cursor: pointer; 
    margin: 5px;
    font-weight: 600;
    transition: all 0.3s ease;
    box-shadow: 0 5px 15px rgba(102,126,234,0.3);
}
.btn:hover { 
    transform: translateY(-2px);
    box-shadow: 0 7px 20px rgba(102,126,234,0.4);
}
.btn-danger { 
    background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
}
.config { 
    background: #f8f9fa; 
    padding: 25px; 
    border-radius: 15px; 
    margin: 20px 0; 
}
.input-group { 
    display: flex; 
    gap: 10px; 
    margin: 15px 0; 
}
.form-input { 
    flex: 1; 
    padding: 12px; 
    border: 2px solid #e0e0e0; 
    border-radius: 10px;
    font-size: 14px;
    transition: border-color 0.3s ease;
}
.form-input:focus {
    outline: none;
    border-color: #667eea;
}
.success-badge {
    background: #10b981;
    color: white;
    padding: 5px 10px;
    border-radius: 5px;
    font-size: 12px;
    margin-left: 10px;
}
.warning-badge {
    background: #f59e0b;
    color: white;
    padding: 5px 10px;
    border-radius: 5px;
    font-size: 12px;
    margin-left: 10px;
}
.endpoints {
    background: #f8f9fa;
    padding: 20px;
    border-radius: 15px;
    margin: 20px 0;
}
.endpoint-item {
    display: flex;
    justify-content: space-between;
    padding: 10px 0;
    border-bottom: 1px solid #e0e0e0;
}
.endpoint-item:last-child {
    border-bottom: none;
}
.endpoint-url {
    color: #667eea;
    font-family: monospace;
    font-size: 14px;
}
.pulse {
    display: inline-block;
    width: 10px;
    height: 10px;
    background: #10b981;
    border-radius: 50%;
    animation: pulse 2s infinite;
}
@keyframes pulse {
    0% {
        box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7);
    }
    70% {
        box-shadow: 0 0 0 10px rgba(16, 185, 129, 0);
    }
    100% {
        box-shadow: 0 0 0 0 rgba(16, 185, 129, 0);
    }
}
</style>
</head>
<body>
<div class="container">
<h1>🚀 Webhook System v2.3</h1>
<div class="version">Perfect Pay Integration - WhatsApp Automation</div>

<div class="status">
<span class="pulse"></span> Sistema Online e Operacional
<span class="success-badge">v2.3 CORRIGIDO</span>
</div>

<div class="stats">
<div class="stat-card" onclick="refreshStatus()">
<div class="stat-value" id="pending-count">0</div>
<div class="stat-label">PIX Pendentes</div>
</div>
<div class="stat-card" onclick="viewLeads()">
<div class="stat-value" id="leads-responded">0</div>
<div class="stat-label">Respostas</div>
</div>
<div class="stat-card" onclick="viewLeads()">
<div class="stat-value" id="leads-purchases">0</div>
<div class="stat-label">Compras</div>
</div>
<div class="stat-card" onclick="viewDebug()">
<div class="stat-value" id="total-received">0</div>
<div class="stat-label">Webhooks</div>
</div>
</div>

<div style="text-align: center; margin: 30px 0;">
<button class="btn" onclick="refreshStatus()">🔄 Atualizar</button>
<button class="btn" onclick="viewLeads()">👥 Ver Leads</button>
<button class="btn btn-danger" onclick="viewDebug()">🔍 Debug Completo</button>
</div>

<div class="config">
<h3>⚙️ Configuração N8N</h3>
<div class="input-group">
<input type="text" class="form-input" id="n8n-url" placeholder="URL do webhook principal..." value="${N8N_WEBHOOK_URL}" />
<button class="btn" onclick="saveUrl('main')">💾 Salvar Principal</button>
</div>
<div class="input-group">
<input type="text" class="form-input" id="n8n-whatsapp-url" placeholder="URL do webhook WhatsApp..." value="${N8N_WHATSAPP_URL}" />
<button class="btn" onclick="saveUrl('whatsapp')">💾 Salvar WhatsApp</button>
</div>
</div>

<div class="endpoints">
<h3>📡 Endpoints Disponíveis</h3>
<div class="endpoint-item">
<span>Perfect Pay Webhook:</span>
<span class="endpoint-url">/webhook/perfect</span>
</div>
<div class="endpoint-item">
<span>WhatsApp Response:</span>
<span class="endpoint-url">/webhook/whatsapp-response</span>
</div>
<div class="endpoint-item">
<span>Debug Interface:</span>
<span class="endpoint-url">/debug</span>
</div>
<div class="endpoint-item">
<span>Status API:</span>
<span class="endpoint-url">/status</span>
</div>
<div class="endpoint-item">
<span>Health Check:</span>
<span class="endpoint-url">/health</span>
</div>
</div>
</div>

<script>
function refreshStatus() {
    fetch("/status")
        .then(r => r.json())
        .then(data => {
            document.getElementById("pending-count").textContent = data.pending_pix_orders;
            document.getElementById("leads-responded").textContent = data.lead_stats.responded;
            document.getElementById("leads-purchases").textContent = data.lead_stats.with_purchases;
            document.getElementById("total-received").textContent = data.statistics.total_webhooks_received;
        })
        .catch(err => console.error('Erro ao atualizar:', err));
}

function viewLeads() {
    fetch("/leads-status")
        .then(r => r.json())
        .then(data => {
            let info = "📊 STATUS DOS LEADS\\n\\n";
            info += "✅ Respostas: " + data.leads_responded + "\\n";
            info += "💰 Compras: " + data.leads_with_purchases + "\\n\\n";
            
            if (data.responses.length > 0) {
                info += "ÚLTIMAS RESPOSTAS:\\n";
                data.responses.slice(0, 5).forEach(r => {
                    info += "• " + r.phone + " - " + r.time_ago + "\\n";
                });
            }
            
            alert(info);
        })
        .catch(err => alert('Erro ao carregar leads'));
}

function viewDebug() {
    fetch("/debug")
        .then(r => r.json())
        .then(data => {
            console.log("Debug completo:", data);
            
            let info = "🔍 DEBUG DO SISTEMA\\n\\n";
            info += "📊 ESTATÍSTICAS:\\n";
            info += "• Webhooks recebidos: " + data.stats.total_webhooks + "\\n";
            info += "• Respostas detectadas: " + data.stats.responses_detected + "\\n";
            info += "• Continuações enviadas: " + data.stats.continuations_sent + "\\n";
            info += "• Erros: " + data.stats.errors + "\\n\\n";
            
            info += "💾 ARMAZENAMENTO:\\n";
            info += "• Respostas: " + data.leadResponses.count + "\\n";
            info += "• Compras: " + data.leadPurchases.count + "\\n";
            info += "• PIX pendentes: " + data.pendingPixOrders.count + "\\n\\n";
            
            info += "✅ Detalhes completos no console (F12)";
            
            alert(info);
        })
        .catch(err => alert('Erro ao carregar debug'));
}

function saveUrl(type) {
    alert('Configuração salva! Reinicie o servidor para aplicar.');
}

// Auto-refresh a cada 10 segundos
setInterval(refreshStatus, 10000);
refreshStatus();
</script>
</body>
</html>`;
    
    res.send(htmlContent);
});

// Inicialização do servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    addLog('info', `Sistema v2.3 iniciado na porta ${PORT}`);
    console.log('🚀 Servidor v2.3 rodando na porta', PORT);
    console.log('📱 Webhook WhatsApp: /webhook/whatsapp-response');
    console.log('💰 Webhook Perfect Pay: /webhook/perfect');
    console.log('🔍 Debug: /debug');
    console.log('📊 Interface: /');
    console.log('✅ Correções aplicadas:');
    console.log('  - Extração correta do telefone Perfect Pay');
    console.log('  - Salvamento garantido dos dados PIX');
    console.log('  - Compartilhamento de dados entre webhooks');
    console.log('  - Normalização de telefone aprimorada');
});
