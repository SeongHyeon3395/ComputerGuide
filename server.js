require('dotenv').config();
const express = require('express');
const path = require('path');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

// Supabase 클라이언트 초기화
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Ko-fi 웹훅을 위해 추가
app.use(express.static(path.join(__dirname, 'public')));

// --- 사용자 인증 API ---

// 회원가입 API
app.post('/api/auth/signup', async (req, res) => {
    const { email, password, name } = req.body;
    const { data, error } = await supabase.auth.signUp({
        email: email,
        password: password,
        options: {
            data: { display_name: name } // Supabase에 이름도 함께 저장
        }
    });
    if (error) return res.status(400).json({ error: error.message });
    res.status(200).json({ user: data.user });
});

// 로그인 API
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    const { data, error } = await supabase.auth.signInWithPassword({
        email: email,
        password: password,
    });
    if (error) return res.status(400).json({ error: error.message });
    res.status(200).json({ session: data.session, user: data.user });
});


// --- 채팅 API (이제 사용자 권한 확인!) ---
app.post('/api/chat', async (req, res) => {
    // 1. 프론트에서 보낸 인증 토큰을 확인합니다.
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: "인증되지 않은 사용자입니다." });

    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) return res.status(401).json({ error: "유효하지 않은 사용자입니다." });

    // 2. DB에서 사용자의 구독 상태를 확인합니다.
    const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('is_premium')
        .eq('id', user.id)
        .single();
        
    if (profileError || !profile) return res.status(500).json({ error: '프로필 정보를 가져오지 못했습니다.' });

    // 3. 프리미엄 유저가 아니라면, 횟수 제한 로직을 적용합니다. (지금은 단순화)
    if (!profile.is_premium) {
        // 실제로는 DB에서 횟수를 차감해야 하지만, 여기서는 간단히 막습니다.
        // 이 예제에서는 횟수 제한을 프론트에서 보여주므로, 여기서는 권한 없음만 알립니다.
        return res.status(403).json({ error: "프리미엄 구독이 필요한 기능입니다." });
    }

    // 4. 권한이 있다면 AI에게 질문합니다.
    const userPrompt = req.body.prompt;
    try {
        const geminiResponse = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${process.env.GEMINI_API_KEY}`,
            { contents: [{ role: "user", parts: [{ text: userPrompt }] }] }
        );
        const generatedText = geminiResponse.data.candidates[0].content.parts[0].text;
        res.json({ text: generatedText });
    } catch (error) {
        res.status(500).json({ error: 'AI 서버와 통신 중 오류가 발생했습니다.' });
    }
});


// --- Ko-fi 웹훅 API ---
app.post('/api/kofi-webhook', async (req, res) => {
    const kofiData = JSON.parse(req.body.data);
    
    // TODO: Ko-fi의 토큰을 확인하여 요청을 검증하는 로직 추가
    
    // 구독 결제이고, 특정 등급일 때만 처리
    if (kofiData.is_subscription_payment && kofiData.tier_name === '프로 멤버십') {
        const userEmail = kofiData.email;
        console.log(`[Ko-fi Webhook] ${userEmail} 님이 프로 멤버십을 구독했습니다.`);

        // DB에서 해당 이메일을 가진 사용자를 찾아 is_premium을 true로 업데이트
        const { data, error } = await supabase
            .from('profiles')
            .update({ is_premium: true })
            .eq('email', userEmail);
            
        if(error) console.error("DB 업데이트 실패:", error);
    }
    res.status(200).send('OK');
});


app.listen(PORT, () => {
    console.log(`서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
});