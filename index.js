require('dotenv/config');
const { Client } = require('discord.js');
const { OpenAI } = require('openai');
const axios = require('axios');
const cheerio = require('cheerio');
const cron = require('node-cron');
const fs = require('fs');
const Parser = require('rss-parser'); // Import RSS Parser
const parser = new Parser();

const client = new Client({
    intents: ['Guilds', 'GuildMembers', 'GuildMessages', 'MessageContent'],
});

const openai = new OpenAI({
    apiKey: process.env.OPENAI_KEY,
});

const IGNORE_PREFIX = '!';
const CHAT_CHANNELS = ['942424044790231070']; // Update with your chatbot channels
const NEWS_CHANNEL_ID = '1320852592447848592'; // Update with your news updates channel
const HISTORY_FILE = 'shared_articles.json';
const SOURCES = {
    rss: [
        { name: "The Verge", url: "http://theverge.com/rss/index.xml" },
        { name: "MIT Tech Review AI", url: "https://www.technologyreview.com/feed" },
        { name: "TechCrunch AI", url: "https://techcrunch.com/feed/" },
        { name: "404 Media", url: "https://www.404media.co/rss/" },
        { name: "Wired", url: "https://www.wired.com/feed/rss" },
        { name: "NBC News", url: "https://www.nbcnews.com/feed" },
        { name: "Fast Company", url: "https://www.fastcompany.com/rss" },
        { name: "Creative Applications", url: "https://www.creativeapplications.net/feed" },
        { name: "Nvidia", url: "https://blogs.nvidia.com/feed/" },
        { name: "Creative Bloq", url: "https://www.creativebloq.com/feeds.xml" },
        { name: "ars technica", url: "https://arstechnica.com/feed" },
        { name: "The Next Web", url: "https://thenextweb.com/feed" },
        { name: "CDM", url: "https://cdm.link/category/motion/feed/" },
        { name: "The Gradient", url: "https://thegradient.pub/rss/" },
    ],
    html: [
        { name: "RunwayML", url: "https://runwayml.com/news" },
        { name: "RunwayML", url: "https://runwayml.com/news" },
    ]
};

// Load chatbot personality
const botPersonality = JSON.parse(fs.readFileSync('personality.json', 'utf8'));

// Load previously shared articles
let sharedArticles = [];
if (fs.existsSync(HISTORY_FILE)) {
    sharedArticles = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
}

// **CHATBOT LOGIC**
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (message.content.startsWith(IGNORE_PREFIX)) return;
    if (!CHAT_CHANNELS.includes(message.channelId) && !message.mentions.users.has(client.user.id)) return;

    await message.channel.sendTyping();

    const sendTypingInterval = setInterval(() => {
        message.channel.sendTyping();
    }, 5000);

    let conversation = [];

    // Use custom digital twin personality
    conversation.push({
        role: 'system',
        content: botPersonality.role + '\n' + JSON.stringify(botPersonality.persona, null, 2) + '\n' +
                 JSON.stringify(botPersonality.interactions, null, 2),
    });

    let prevMessages = await message.channel.messages.fetch({ limit: 10 });
    prevMessages.reverse();

    prevMessages.forEach((msg) => {
        if (msg.author.bot && msg.author.id !== client.user.id) return;
        if (msg.content.startsWith(IGNORE_PREFIX)) return;

        const username = msg.author.username.replace(/\s+/g, '_').replace(/[^\w\s]/gi, '');

        if (msg.author.id === client.user.id) {
            conversation.push({ role: 'assistant', name: username, content: msg.content });
            return;
        }

        conversation.push({ role: 'user', name: username, content: msg.content });
    });

    const response = await openai.chat.completions
        .create({ model: 'gpt-4', messages: conversation })
        .catch((error) => console.error('OpenAI Error:\n', error));

    clearInterval(sendTypingInterval);

    if (!response) {
        message.reply("I'm having some trouble with the OpenAI API. Try again in a moment.");
        return;
    }

    const responseMessage = response.choices[0].message.content;
    const chunkSizeLimit = 2000;

    for (let i = 0; i < responseMessage.length; i += chunkSizeLimit) {
        const chunk = responseMessage.substring(i, i + chunkSizeLimit);
        await message.reply(chunk);
    }
});

// **NEWS SCRAPING & SUMMARIZATION LOGIC**
async function scrapeArticles() {
    console.log("🔄 Scraping both RSS feeds & HTML pages...");

    // Fetch RSS & HTML articles in parallel
    const [rssArticles, htmlArticles] = await Promise.all([
        scrapeRSSFeeds(),
        scrapeHTMLArticles()
    ]);

    // Combine results
    const allArticles = [...rssArticles, ...htmlArticles];
    console.log(`✅ Found ${allArticles.length} new articles.`);
    return allArticles;
}
// **NEWS SCRAPING RSS**
async function scrapeRSSFeeds() {
    let rssArticles = [];
    const fiveDaysAgo = new Date();
    fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 3); // Get the date 5 days ago

    const fetchPromises = SOURCES.rss.map(async (source) => {
        try {
            console.log(`🔍 Fetching RSS feed: ${source.name}`);
            const feed = await parser.parseURL(source.url);

            feed.items.forEach((item) => {
                const pubDate = new Date(item.pubDate);
                if (pubDate < fiveDaysAgo) return; // Skip old articles

                if (!sharedArticles.includes(item.link)) {
                    rssArticles.push({
                        source: source.name,
                        title: item.title,
                        url: item.link,
                        summary: item.contentSnippet || item.description || "No summary available.",
                        date: pubDate
                    });
                }
            });
        } catch (error) {
            console.error(`❌ Error fetching RSS feed from ${source.name}:`, error.message);
        }
    });

    await Promise.all(fetchPromises);
    return rssArticles;
}
// **NEWS SCRAPING HTML**
async function scrapeHTMLArticles() {
    let htmlArticles = [];
    const maxArticlesPerSite = 5; // Limit to the first 5 articles per source

    const fetchPromises = SOURCES.html.map(async (source) => {
        try {
            console.log(`🔍 Scraping website: ${source.name}`);

            const response = await axios.get(source.url, {
                headers: { 'Accept-Encoding': 'gzip, deflate, br' },
                timeout: 10000
            });

            const $ = cheerio.load(response.data);

            $('article a, h2 a').each((i, element) => {
                if (i >= maxArticlesPerSite) return; // Stop after collecting maxArticlesPerSite

                let articleUrl = $(element).attr('href');

                if (!articleUrl.startsWith('http')) {
                    articleUrl = new URL(articleUrl, source.url).href;
                }

                if (!sharedArticles.includes(articleUrl)) {
                    htmlArticles.push({
                        source: source.name,
                        url: articleUrl,
                        summary: "Summary will be generated."
                    });
                }
            });
        } catch (error) {
            console.error(`❌ Error scraping ${source.name}:`, error.message);
        }
    });

    await Promise.all(fetchPromises);
    return htmlArticles;
}


// **Summarize Articles Using OpenAI**
async function summarizeArticle(url) {
    try {
        const response = await openai.chat.completions.create({
            model: 'gpt-4',
            messages: [
                {
                    role: 'system',
                    content: `Summarize this article in only 1-2 sentences, strictly focusing on AI, creativity, and technological innovation. 
                    🚫 Do NOT include anything related to politics, government policies, elections, war, activism, or social justice topics. 
                    Keep it concise, under 280 characters.`
                },
                { role: 'user', content: `Article URL: ${url}\n\nPlease summarize in 1-2 sentences, focusing ONLY on generative AI, creative technology, and innovation.` }
            ],
        });

        let summary = response.choices[0].message.content.trim();

        // 🔥 Hard limit to 280 characters
        if (summary.length > 280) {
            summary = summary.slice(0, 277) + "..."; // Truncate with ellipsis
        }

        return summary;
    } catch (error) {
        console.error(`❌ OpenAI Error while summarizing ${url}:`, error.message);
        return "Summary unavailable.";
    }
}


// Rank Articles Using OpenAI**
async function rankArticles(articles) {
    if (articles.length === 0) return [];

    // Limit number of articles sent to OpenAI (max 10)
    const articlesToRank = articles.slice(0, 10);

    try {
        const formattedArticles = articlesToRank
            .map((a, i) => `Article ${i + 1}:\nSource: ${a.source}\nTitle: ${a.title}\nSummary: ${a.summary}\nLink: ${a.url}`)
            .join("\n\n");

        const response = await openai.chat.completions.create({
            model: 'gpt-4',
            messages: [
                { 
                    role: 'system', 
                    content: `You are an AI assistant ranking the top articles on generative AI, creative technology, and creative innovation. 
                    🚫 Completely ignore political relevance. 
                    Focus only on advancements in generative and creative AI, media and entertainment, immersive experiences, design innovation, and technology-driven creativity.` 
                },
                { role: 'user', content: `Here are 10 articles:\n\n${formattedArticles}\n\nPlease rank the top 3 based strictly on AI, creative technology, and innovation.` }
            ],
        });

        console.log("🔢 GPT-4 Ranking Results:\n", response.choices[0].message.content);

        const topIndexes = response.choices[0].message.content.match(/Article (\d+)/g);
        if (!topIndexes) return enforceSourceDiversity(articlesToRank);

        return topIndexes.slice(0, 3).map(index => articlesToRank[parseInt(index.replace('Article ', '')) - 1]);
    } catch (error) {
        console.error(`❌ OpenAI Error while ranking articles:`, error.message);
        return enforceSourceDiversity(articlesToRank);
    }
}

// Manually enforcing Diversity
function enforceSourceDiversity(articles) {
    const selectedArticles = [];
    const usedSources = new Set();

    for (const article of articles) {
        if (!usedSources.has(article.source)) {
            selectedArticles.push(article);
            usedSources.add(article.source);
        }
        if (selectedArticles.length === 3) break;
    }

    // If not enough unique sources, fill with best available
    if (selectedArticles.length < 3) {
        for (const article of articles) {
            if (!selectedArticles.includes(article)) {
                selectedArticles.push(article);
                if (selectedArticles.length === 3) break;
            }
        }
    }

    console.log("📌 Final Selected Articles (Diverse Sources):", selectedArticles.map(a => a.source));
    return selectedArticles;
}


// **Post Top 3 Articles**
const POLITICAL_KEYWORDS = [
    "politics", "government", "policy", "election", "war", "conflict", "activism",
    "senate", "congress", "president", "minister", "law", "protest", "rights", "bills",
    "diplomacy", "sanctions", "military", "parliament", "legislation", "censorship"
];

async function postTopArticles() {
    const channel = await client.channels.fetch(NEWS_CHANNEL_ID);
    if (!channel) {
        console.error('❌ Discord channel not found.');
        return;
    }

    console.log('🔍 Checking for new articles...');
    const newArticles = await scrapeArticles();
    let relevantArticles = [];

    for (const article of newArticles) {
        if (!article.url || article.url.trim() === '') {
            console.warn(`⚠️ Skipping article from ${article.source} because it has no URL.`);
            continue; // Skip articles without a URL
        }

        if (article.summary === "Summary will be generated.") {
            article.summary = await summarizeArticle(article.url);
        }

        // 🚨 Check for political keywords in title or summary
        const fullText = `${article.title} ${article.summary}`.toLowerCase();
        if (POLITICAL_KEYWORDS.some(keyword => fullText.includes(keyword))) {
            console.warn(`🚫 Skipping political article: ${article.title}`);
            continue; // Skip political content
        }

        if (article.summary && (article.summary.toLowerCase().includes('ai') || article.summary.toLowerCase().includes('creative technology') || article.summary.toLowerCase().includes('creative innovation'))) {
            relevantArticles.push(article);
        }
    }

    console.log(`✅ ${relevantArticles.length} relevant articles found.`);
    if (relevantArticles.length === 0) {
        console.log('🚫 No relevant articles found.');
        return;
    }

    let topArticles = await rankArticles(relevantArticles);
    topArticles = enforceSourceDiversity(topArticles); // Ensure 3 different sources

    console.log(`⏳ Posting ${topArticles.length} articles with a 20-second delay between each...`);

    for (let i = 0; i < topArticles.length; i++) {
        const article = topArticles[i];

        // 🔥 Ensure Summary is 1-2 Sentences Only
        let trimmedSummary = article.summary.split('. ').slice(0, 2).join('. ') + '.';

        // 🔗 Ensure Message Contains the Article Link
        let message = `📰 **${article.source} Update**\n${trimmedSummary}\n🔗 [Read more](${article.url})`;

        // 🔥 Ensure Message is Under Discord's 2000 Character Limit
        if (message.length > 2000) {
            console.warn(`⚠️ Trimming long message from ${article.source}`);
            message = message.slice(0, 1990) + "..."; // Keep safe buffer
        }

        setTimeout(async () => {
            try {
                await channel.send(message);
                sharedArticles.push(article.url);
                fs.writeFileSync(HISTORY_FILE, JSON.stringify(sharedArticles, null, 2));
                console.log(`✅ Posted: ${article.source} - ${article.url}`);
            } catch (error) {
                console.error(`❌ Failed to send message:`, error);
            }
        }, i * 20000); // Delay each article by (index * 20 seconds)
    }
}



// **SCHEDULED TASK TO RUN EVERY 5 MINUTES**

cron.schedule('0 9 * * *', () => {
    console.log('Running scheduled news update...');
    postUpdates();
}, {
    timezone: "UTC"
});

// cron.schedule('*/5 * * * *', () => {
//     console.log('Running scheduled news update...');
//     postTopArticles();
// }, {
//     timezone: "UTC"
// });

// **BOT STARTUP**
client.once('ready', () => {
    console.log('The bot is online.');
    postTopArticles(); // Run once on startup
});

client.login(process.env.TOKEN);