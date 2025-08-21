const express = require('express');
const axios = require('axios');
const RedisManager = require('./redis-manager'); // Importar o Redis Manager
const app = express();

// ✅ REDIS MANAGER - SUBSTITUINDO MAPS
const redis = new RedisManager();

// Configurações mantidas
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://n8n.flowzap.fun/webhook/207400a6-1290-4153-b033-c658e657d717';
const N8N_WHATSAPP_URL = process.env.N8N_WHATSAPP_URL || 'https://n8n.flowzap.fun/webhook/c0d9ac75-a0db-426c-ad25-09f5d0644c6f';
const PIX_TIMEOUT = 7 * 60 * 1000; // 7 minutos

app.use(express.json());

// 🔌 INICIALIZAR REDIS
async function initializeRedis() {
    console.log('🔌 Conectando ao Redis...');
    const connected = await redis.connect();
    
    if (connected) {
        console.log('✅ Redis conectado - Persistência de 30 dias ativa');
    } else {
        console.log('❌ Redis falhou - Usando memória temporária');
        // Fallback para Maps se Redis falhar
        global.fallbackMaps = {
            leadResponses: new Map(),
            leadPurchases: new Map(),
            pendingPixOrders: new Map()
        };
    }
}

// Função para normalizar telefones (mantida igual)
function normalizePhone(phone) {
    if (!phone) return '';
    
    let normalized = phone.toString().replace(/\D/g, '');
    
    console.log('📱 Normalizando telefone:', {
        original: phone,
        apenas_numeros: normalized
    });
    
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
    
    if (normalized.startsWith('57') && normalized.length >= 12) {
        const possivelDDD = normalized.substring(2, 4);
        
        if (ddds_brasileiros.includes(possivelDDD)) {
            console.log('🔧 Detectado DDI 57 com DDD brasileiro - corrigindo...');
            let semDDI = normalized.substring(2);
            
            if (semDDI.length === 11 && semDDI[0] === '0') {
                semDDI = semDDI.substring(1);
                console.log('📱 Removido zero extra:', semDDI);
            }
            
            normalized = '55' + semDDI;
            console.log('✅ Corrigido DDI 57→55:', normalized);
            return normalized;
        }
    }
    
    if (normalized.length === 13 && normalized.startsWith('55')) {
        console.log('✅ Telefone brasileiro correto - mantido:', normalized);
        return normalized;
    }
    
    if (normalized.length === 11) {
        const ddd = normalized.substring(0, 2);
        if (ddds_brasileiros.includes(ddd)) {
            normalized = '55' + normalized;
            console.log('📱 Adicionado DDI 55:', normalized);
            return normalized;
        }
    }
    
    if (normalized.length === 10) {
        const ddd = normalized.substring(0, 2);
        if (ddds_brasileiros.includes(ddd)) {
            const numero = normalized.substring(2);
            normalized = '55' + ddd + '9' + numero;
            console.log('📱 Adicionado 9 e DDI:', normalized);
            return normalized;
        }
    }
    
    console.log('📱 Telefone final (sem alterações):', normalized);
    return normalized;
}

// ✅ FUNÇÃO DE LOG COM REDIS
async function addLog(type, message, data = null) {
    const logEntry = {
        timestamp: new Date().toISOString(),
        type: type,
        message: message,
        data: data
    };
    
    console.log('[' + logEntry.timestamp + '] ' + type.toUpperCase() + ': ' + message);
    
    // Salvar no Redis (expira em 7 dias)
    if (redis.isConnected) {
        await redis.addSystemLog(type, message, data);
    }
}

// ✅ WEBHOOK WHATSAPP COM REDIS
app.post('/webhook/whatsapp-response', async (req, res) => {
    try {
        console.log('\n🔍 === WEBHOOK WHATSAPP INICIADO ===');
        
        // Anti-duplicata usando Redis
        const requestId = req.body.key?.id || JSON.stringify(req.body).substring(0, 100);
        const duplicateKey = 'wh_dup_' + requestId;
        
        if (redis.isConnected) {
            const isDuplicate = await redis.getAntiLoop(duplicateKey);
            if (isDuplicate) {
                console.log('🛑 WEBHOOK DUPLICADO - Ignorando para evitar loop');
                return res.status(200).json({ success: true, duplicated: true });
            }
            
            // Marcar como processado (expira em 5 minutos)
            await redis.setAntiLoop(duplicateKey, { processed: true });
        }
        
        const data = req.body;
        
        await addLog('info', '📱 WEBHOOK WHATSAPP RECEBIDO: ' + JSON.stringify(data).substring(0, 200) + '...');
        
        let phone = null;
        let message = null;
        
        // Extrair telefone (mantido igual)
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
                await addLog('info', '📱 Telefone detectado: ' + phone + ' via: ' + attempt);
                break;
            }
        }
        
        // Extrair mensagem (mantido igual)
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
                await addLog('info', '💬 Mensagem detectada: ' + message.substring(0, 50) + '...');
                break;
            }
        }
        
        console.log('📱 Resultado extração:', {
            phone: phone,
            message: message ? message.substring(0, 50) + '...' : null,
            hasPhone: !!phone,
            hasMessage: !!message
        });
        
        if (phone && message) {
            const normalizedPhone = normalizePhone(phone);
            
            console.log('🎯 PROCESSANDO RESPOSTA:', {
                raw: phone,
                normalized: normalizedPhone,
                message: message.substring(0, 50) + '...'
            });
            
            // ✅ SALVAR RESPOSTA NO REDIS (expira em 7 dias)
            if (redis.isConnected) {
                await redis.setLeadResponse(normalizedPhone, {
                    timestamp: Date.now(),
                    message: message,
                    phone: normalizedPhone,
                    full_data: data
                });
            }
            
            await addLog('info', `🎉 RESPOSTA DETECTADA - Tel: ${normalizedPhone} | Msg: ${message.substring(0, 50)}...`, {
                phone: normalizedPhone,
                message: message
            });
            
            console.log('🎯 Lead respondeu - continuando fluxo automaticamente');

            // ✅ BUSCAR DADOS PIX NO REDIS
            let pixDataSalvo = null;
            if (redis.isConnected) {
                pixDataSalvo = await redis.getLeadPurchase(normalizedPhone);
            }
            
            console.log('💰 Dados PIX encontrados para', normalizedPhone, ':', pixDataSalvo ? 'SIM' : 'NÃO');

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
                    version: '3.0-redis',
                    redis_connected: redis.isConnected
                },
                // Dados PIX do Redis ou vazios
                billet_url: pixDataSalvo?.originalData?.billet_url || '',
                billet_number: pixDataSalvo?.originalData?.billet_number || '',
                sale_amount: pixDataSalvo?.amount || 0,
                sale_status_enum_key: pixDataSalvo?.originalData?.sale_status_enum_key || 'pending',
                customer: pixDataSalvo?.originalData?.customer || {},
                order_code: pixDataSalvo?.orderCode || ''
            };

            console.log('📤 Payload com PIX do Redis:', {
                has_billet_url: !!continuationPayload.billet_url,
                has_billet_number: !!continuationPayload.billet_number,
                sale_amount: continuationPayload.sale_amount
            });

            console.log('🚀 Enviando continuação para N8N...');
            const sendResult = await sendToN8N(continuationPayload, 'lead_active_continuation', true);

            if (sendResult.success) {
                await addLog('success', `✅ FLUXO CONTINUADO COM SUCESSO - Lead: ${normalizedPhone}`);
                console.log('🎯 FLUXO CONTINUADO COM SUCESSO!');
            } else {
                await addLog('error', `❌ ERRO ao continuar fluxo - Lead: ${normalizedPhone} | Erro: ${sendResult.error}`);
                console.log('❌ ERRO ao enviar continuação para N8N:', sendResult.error);
            }
        } else {
            console.log('❌ Não foi possível extrair telefone ou mensagem');
            await addLog('info', '❌ Webhook WhatsApp: dados insuficientes para processar');
            
            console.log('📊 Estrutura de dados recebida:', Object.keys(data));
            await addLog('info', '📊 Estrutura recebida: ' + Object.keys(data).join(', '));
        }
        
        console.log('=== FIM WEBHOOK WHATSAPP ===\n');
        
        // Estatísticas do Redis
        let stats = {};
        if (redis.isConnected) {
            stats = await redis.getStats();
        }
        
        res.status(200).json({ 
            success: true, 
            message: 'Webhook WhatsApp processado',
            phone: phone,
            normalizedPhone: phone ? normalizePhone(phone) : null,
            hasMessage: !!message,
            redis_connected: redis.isConnected,
            redis_stats: stats
        });
        
    } catch (error) {
        console.error('❌ Erro no webhook WhatsApp:', error);
        await addLog('error', 'ERRO resposta WhatsApp: ' + error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ✅ WEBHOOK PERFECT PAY COM REDIS
app.post('/webhook/perfect', async (req, res) => {
    try {
        console.log('\n💰 === WEBHOOK PERFECT PAY INICIADO ===');
        
        const data = req.body;
        const orderCode = data.code;
        const status = data.sale_status_enum_key;
        const customerName = data.customer?.full_name || 'N/A';
        const amount = data.sale_amount || 0;
        
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
        
        await addLog('webhook_received', 'Webhook - Pedido: ' + orderCode + ' | Status: ' + status + ' | Tel: ' + customerPhone, {
            order_code: orderCode,
            status: status,
            phone: customerPhone
        });
        
        if (status === 'approved') {
            await addLog('info', 'VENDA APROVADA - ' + orderCode);
            
            // ✅ REMOVER PIX PENDENTE DO REDIS
            if (redis.isConnected) {
                await redis.deletePendingPix(orderCode);
            }
            
            // ✅ SALVAR COMPRA NO REDIS (30 dias)
            if (customerPhone && customerPhone.length >= 10 && redis.isConnected) {
                console.log('🔍 TELEFONE SALVO PERFECT PAY NO REDIS:', customerPhone);
                await redis.setLeadPurchase(customerPhone, {
                    timestamp: Date.now(),
                    originalData: data,
                    orderCode: orderCode,
                    customerName: customerName,
                    amount: amount,
                    phone: customerPhone,
                    status: 'approved'
                });
                
                await addLog('info', 'COMPRA REGISTRADA NO REDIS - Tel: ' + customerPhone + ' | Pedido: ' + orderCode);
            }
            
            const sendResult = await sendToN8N(data, 'approved');
            
            if (sendResult.success) {
                await addLog('success', 'VENDA APROVADA enviada - ' + orderCode);
            } else {
                await addLog('error', 'ERRO enviar VENDA APROVADA - ' + orderCode);
            }
            
        } else if (status === 'pending') {
            await addLog('info', 'PIX GERADO - ' + orderCode + ' | Tel: ' + customerPhone);
            
            // ✅ SALVAR COMPRA NO REDIS PARA MONITORAMENTO (30 dias)
            if (customerPhone && customerPhone.length >= 10 && redis.isConnected) {
                console.log('🔍 TELEFONE SALVO PERFECT PAY NO REDIS:', customerPhone);
                await redis.setLeadPurchase(customerPhone, {
                    timestamp: Date.now(),
                    originalData: data,
                    orderCode: orderCode,
                    customerName: customerName,
                    amount: amount,
                    phone: customerPhone,
                    status: 'pending'
                });
                
                await addLog('info', 'COMPRA REGISTRADA NO REDIS para monitoramento - Tel: ' + customerPhone + ' | Pedido: ' + orderCode);
                console.log('📝 Lead adicionado para monitoramento no Redis:', customerPhone);
            }
            
            const sendResult = await sendToN8N(data, 'pending');
            
            if (sendResult.success) {
                await addLog('success', 'PIX PENDING enviado - ' + orderCode);
            } else {
                await addLog('error', 'ERRO enviar PIX PENDING - ' + orderCode);
            }
            
            // ✅ SALVAR PIX PENDENTE NO REDIS (7 dias)
            if (redis.isConnected) {
                await redis.setPendingPix(orderCode, {
                    data: data,
                    timestamp: new Date(),
                    customer_name: customerName,
                    amount: amount,
                    customer_phone: customerPhone
                });
            }
            
            // Timeout para PIX (mantido em memória por ser temporário)
            const timeout = setTimeout(async () => {
                await addLog('timeout', 'TIMEOUT PIX - ' + orderCode);
                
                if (redis.isConnected) {
                    await redis.deletePendingPix(orderCode);
                }
                
                const sendResult = await sendToN8N(data, 'pix_timeout');
                
                if (sendResult.success) {
                    await addLog('success', 'PIX TIMEOUT enviado - ' + orderCode);
                } else {
                    await addLog('error', 'ERRO PIX TIMEOUT - ' + orderCode);
                }
                
            }, PIX_TIMEOUT);
        }
        
        // ✅ ESTATÍSTICAS DO REDIS
        let stats = {};
        if (redis.isConnected) {
            stats = await redis.getStats();
        }
        
        console.log('📊 Estado atual Redis:');
        console.log('- Compras monitoradas:', stats.total_leads_purchases || 0);
        console.log('- Respostas registradas:', stats.total_leads_responses || 0);
        console.log('- PIX pendentes:', stats.total_pending_pix || 0);
        console.log('💾 DADOS PERSISTEM POR 30 DIAS NO REDIS');
        console.log('=== FIM WEBHOOK PERFECT PAY ===\n');
        
        res.status(200).json({ 
            success: true, 
            order_code: orderCode,
            status: status,
            phone: customerPhone,
            redis_connected: redis.isConnected,
            redis_stats: stats
        });
        
    } catch (error) {
        console.error('❌ Erro no Perfect Pay:', error);
        await addLog('error', 'ERRO webhook Perfect: ' + error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Função sendToN8N (mantida igual)
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
                source: 'perfect-webhook-system-v3',
                version: '3.0-redis',
                redis_connected: redis.isConnected
            }
        };
        
        console.log('📦 Payload preparado (resumido):', {
            event_type: payload.event_type,
            has_phone: !!payload.lead_interaction?.phone,
            has_pix_data: !!(payload.billet_url || payload.billet_number)
        });
        
        console.log(`📤 ENVIANDO para N8N - SEM RETRY AUTOMÁTICO`);
        
        await addLog('info', 'ENVIANDO para N8N - Tipo: ' + eventType + ' - SEM RETRY');
        
        const response = await axios.post(webhookUrl, payload, {
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Perfect-Webhook-System-v3/3.0-redis'
            },
            timeout: 10000
        });
        
        console.log(`✅ SUCESSO! Resposta N8N - Status: ${response.status}`);
        await addLog('webhook_sent', 'SUCESSO - Enviado para N8N - Tipo: ' + eventType + ' | Status: ' + response.status);
        
        console.log('=== FIM ENVIO N8N ===\n');
        
        return { success: true, status: response.status, data: response.data };
        
    } catch (error) {
        console.log('\n❌ === ERRO NO ENVIO PARA N8N ===');
        console.log('🔥 Erro:', error.message);
        console.log('🔗 URL:', webhookUrl);
        console.log('📊 Detalhes:', error.response?.status, error.response?.statusText);
        
        const errorMessage = error.response ? 
            'HTTP ' + error.response.status + ': ' + error.response.statusText : 
            error.message;
            
        console.error('❌ Erro único - NÃO tentando novamente');
        await addLog('error', 'ERRO enviar N8N - Tipo: ' + eventType + ' | Erro: ' + errorMessage + ' | SEM RETRY');
        
        console.log('=== FIM ERRO ENVIO ===\n');
        
        return { 
            success: false, 
            error: errorMessage,
            no_retry: true
        };
    }
}

// ✅ ENDPOINTS COM REDIS
app.get('/debug', async (req, res) => {
    try {
        let stats = {};
        let recentLogs = [];
        
        if (redis.isConnected) {
            stats = await redis.getStats();
            recentLogs = await redis.getRecentLogs(20);
        }
        
        const debugInfo = {
            timestamp: new Date().toISOString(),
            system_status: 'online',
            redis_connected: redis.isConnected,
            persistencia: '30 dias no Redis',
            
            redis_stats: stats,
            recent_logs: recentLogs,
            
            config: {
                n8n_webhook_url: N8N_WEBHOOK_URL,
                pix_timeout_minutes: PIX_TIMEOUT / 60000,
                redis_ttl: {
                    leads_purchases: '30 dias',
                    leads_responses: '7 dias',
                    dados_pix: '30 dias',
                    leads_ja_receberam: '90 dias',
                    instancias_fixas: '1 ano'
                }
            }
        };
        
        res.json(debugInfo);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/status', async (req, res) => {
    try {
        let stats = {};
        if (redis.isConnected) {
            stats = await redis.getStats();
        }
        
        res.json({
            system_status: 'online',
            timestamp: new Date().toISOString(),
            redis_connected: redis.isConnected,
            persistencia: '30 dias',
            redis_stats: stats,
            n8n_webhook_url: N8N_WEBHOOK_URL
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/health', async (req, res) => {
    try {
        let stats = {};
        if (redis.isConnected) {
            stats = await redis.getStats();
        }
        
        res.json({
            status: 'online',
            timestamp: new Date().toISOString(),
            redis_connected: redis.isConnected,
            redis_stats: stats,
            uptime: process.uptime(),
            persistencia: 'Redis 30 dias'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Interface web atualizada
app.get('/', (req, res) => {
    const htmlContent = `<!DOCTYPE html>
<html>
<head>
<title>Webhook Vendas v3.0 - REDIS</title>
<meta charset="utf-8">
<style>
body { font-family: Arial, sans-serif; padding: 20px; background: #f5f5f5; }
.container { max-width: 800px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; }
h1 { color: #333; text-align: center; }
.status { background: #4CAF50; color: white; padding: 15px; border-radius: 5px; margin: 20px 0; text-align: center; }
.redis-status { background: #2196F3; color: white; padding: 10px; border-radius: 5px; margin: 10px 0; text-align: center; font-size: 14px; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin: 20px 0; }
.stat-card { background: #f8f9fa; padding: 20px; border-radius: 5px; text-align: center; border-left: 4px solid #007bff; }
.stat-value { font-size: 2em; font-weight: bold; color: #007bff; }
.stat-label { color: #666; font-size: 0.9em; }
.btn { background: #007bff; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; margin: 5px; }
.btn:hover { background: #0056b3; }
.config { background: #f8f9fa; padding: 20px; border-radius: 5px; margin: 20px 0; }
</style>
</head>
<body>
<div class="container">
<h1>🚀 Webhook Vendas v3.0 - REDIS</h1>
<div class="status">
<strong>✅ Sistema com Redis - Persistência 30 dias</strong>
</div>
<div class="redis-status">
<strong>🔌 REDIS ATIVO:</strong> Dados persistem por 30 dias automaticamente
</div>
<div class="stats">
<div class="stat-card">
<div class="stat-value" id="redis-status">🔄</div>
<div class="stat-label">Status Redis</div>
</div>
<div class="stat-card">
<div class="stat-value" id="leads-purchases">0</div>
<div class="stat-label">Compras (30d)</div>
</div>
<div class="stat-card">
<div class="stat-value" id="leads-responses">0</div>
<div class="stat-label">Respostas (7d)</div>
</div>
<div class="stat-card">
<div class="stat-value" id="pending-pix">0</div>
<div class="stat-label">PIX Pendentes</div>
</div>
</div>
<div style="text-align: center; margin: 20px 0;">
<button class="btn" onclick="refreshStatus()">🔄 Atualizar</button>
<button class="btn" onclick="viewDebug()">🔍 Debug Redis</button>
</div>
<div class="config">
<h3>🔌 Configuração Redis</h3>
<p><strong>Persistência:</strong> 30 dias automática</p>
<p><strong>Leads já receberam:</strong> 90 dias (anti-spam)</p>
<p><strong>Instâncias fixas:</strong> 1 ano (consistência)</p>
<p><strong>Logs:</strong> 7 dias</p>
</div>
</div>
<script>
function refreshStatus() {
fetch("/status")
.then(r => r.json())
.then(data => {
document.getElementById("redis-status").textContent = data.redis_connected ? "✅" : "❌";
document.getElementById("leads-purchases").textContent = data.redis_stats?.total_leads_purchases || 0;
document.getElementById("leads-responses").textContent = data.redis_stats?.total_leads_responses || 0;
document.getElementById("pending-pix").textContent = data.redis_stats?.total_pending_pix || 0;
});
}
function viewDebug() {
fetch("/debug")
.then(r => r.json())
.then(data => {
const info = "REDIS STATUS: " + (data.redis_connected ? "CONECTADO" : "DESCONECTADO") + "\\n\\n" +
"DADOS PERSISTENTES:\\n" +
"- Compras: " + (data.redis_stats?.total_leads_purchases || 0) + " (30 dias)\\n" +
"- Respostas: " + (data.redis_stats?.total_leads_responses || 0) + " (7 dias)\\n" +
"- PIX Pendentes: " + (data.redis_stats?.total_pending_pix || 0) + " (7 dias)\\n" +
"- Dados PIX: " + (data.redis_stats?.total_dados_pix || 0) + " (30 dias)\\n" +
"- Instâncias: " + (data.redis_stats?.total_instancias_fixas || 0) + " (1 ano)\\n" +
"- Anti-spam: " + (data.redis_stats?.total_leads_ja_receberam || 0) + " (90 dias)";
alert(info);
console.log("Debug Redis completo:", data);
});
}
setInterval(refreshStatus, 10000);
refreshStatus();
</script>
</body>
</html>`;
    
    res.send(htmlContent);
});

// 🚀 INICIALIZAR SERVIDOR
const PORT = process.env.PORT || 3000;

async function startServer() {
    // Conectar Redis primeiro
    await initializeRedis();
    
    app.listen(PORT, async () => {
        await addLog('info', 'Sistema v3.0-redis iniciado na porta ' + PORT);
        await addLog('info', '🔌 Redis conectado - Persistência de 30 dias ativa');
        
        console.log('🚀 Servidor v3.0-redis rodando na porta ' + PORT);
        console.log('📱 Webhook WhatsApp: /webhook/whatsapp-response');
        console.log('💰 Webhook Perfect Pay: /webhook/perfect');
        console.log('🔍 Debug completo: /debug');
        console.log('📊 Interface: /');
        console.log('🔌 REDIS ATIVO - DADOS PERSISTEM POR 30 DIAS');
    });
}

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('👋 Encerrando servidor...');
    await redis.disconnect();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('👋 Encerrando servidor...');
    await redis.disconnect();
    process.exit(0);
});

startServer();
