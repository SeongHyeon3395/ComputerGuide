require('dotenv').config();
const express = require('express');
const path = require('path');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

// Supabase 클라이언트 초기화
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// --- 사용자 인증 API ---
app.post('/api/auth/signup', async (req, res) => {
    const { email, password, name } = req.body;
    const { data: authData, error: authError } = await supabase.auth.signUp({
        email: email,
        password: password,
        options: {
            data: { display_name: name }
        }
    });

    if (authError) return res.status(400).json({ error: authError.message });
    if (!authData.user) return res.status(500).json({error: "유저 생성 후 정보를 찾지 못했습니다."})

    // profiles 테이블에 추가 정보 생성
    const { error: profileError } = await supabase.from('profiles').insert({
        id: authData.user.id, email: email, display_name: name, plan_type: 'free', chat_credits: 5
    });

    if (profileError) {
        // 만약 프로필 생성에 실패하면, 방금 만든 auth.users의 유저도 삭제해주는 것이 좋습니다 (롤백).
        await supabase.auth.admin.deleteUser(authData.user.id);
        return res.status(400).json({ error: profileError.message });
    }

    res.status(200).json({ user: authData.user });
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    const { data, error } = await supabase.auth.signInWithPassword({ email: email, password: password });
    if (error) return res.status(400).json({ error: error.message });
    res.status(200).json({ session: data.session });
});


// --- 채팅 API (구독자 권한 확인) ---
app.post('/api/chat', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: "인증 토큰이 없습니다." });

    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) return res.status(401).json({ error: "유효하지 않은 사용자입니다." });

    const { data: profile, error: profileError } = await supabase
        .from('profiles').select('*').eq('id', user.id).single();
    if (profileError) return res.status(500).json({ error: '프로필 정보를 가져오지 못했습니다.' });

    // 구독 플랜에 따른 권한 확인
    if (profile.plan_type === 'pro') {
        // 프로 플랜은 무제한 통과
    } else { // standard 또는 free
        if (profile.chat_credits <= 0) {
            return res.status(403).json({ error: '채팅 크레딧을 모두 소진했습니다. 플랜을 업그레이드해주세요.' });
        }
        // 크레딧 차감
        await supabase.from('profiles').update({ chat_credits: profile.chat_credits - 1 }).eq('id', user.id);
    }

    // Gemini AI API 호출
    const userPrompt = req.body.prompt;
    try {
        const geminiResponse = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${process.env.GEMINI_API_KEY}`,
            { contents: [{ role: "user", parts: [{ text: userPrompt }] }] }
        );
        res.json({ text: geminiResponse.data.candidates[0].content.parts[0].text });
    } catch (error) {
        // AI 호출 실패 시 차감했던 크레딧 복구
        if (profile.plan_type !== 'pro') {
            await supabase.from('profiles').update({ chat_credits: profile.chat_credits }).eq('id', user.id);
        }
        res.status(500).json({ error: 'AI 서버와 통신 중 오류가 발생했습니다.' });
    }
});


// --- Ko-fi 웹훅 API ---
app.post('/api/kofi-webhook', async (req, res) => {
    const kofiData = JSON.parse(req.body.data);
    
    // 실제 운영 시에는 Ko-fi의 토큰을 확인하여 요청을 검증해야 합니다.
    // if (req.header('x-kofi-token') !== process.env.KOFI_VERIFICATION_TOKEN) {
    //     return res.status(401).send('Unauthorized');
    // }
    
    if (kofiData.is_subscription_payment) {
        const userEmail = kofiData.email;
        let newPlanData = {};

        if (kofiData.tier_name === '스탠다드 플랜') {
            newPlanData = { plan_type: 'standard', chat_credits: 200 };
        } else if (kofiData.tier_name === '프로 플랜') {
            newPlanData = { plan_type: 'pro', chat_credits: 999999 }; // 무제한
        }

        if (newPlanData.plan_type) {
            console.log(`[Ko-fi] ${userEmail} 님이 ${kofiData.tier_name}을 구독했습니다.`);
            const { error } = await supabase.from('profiles').update(newPlanData).eq('email', userEmail);
            if(error) console.error("[DB Error] Ko-fi 구독자 업데이트 실패:", error);
        }
    }
    res.status(200).send('OK');
});


app.listen(PORT, () => {
    console.log(`서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
});