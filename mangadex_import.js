require('dotenv').config();
const axios = require('axios');
const fs = require('fs').promises;
const { join } = require('path');
const xml2js = require('xml2js');

const APP_NAME = 'Fire-Export/Import';
const APP_VERSION = '1.0.0';
const USER_AGENT = `${APP_NAME} ${APP_VERSION}`;

// Logger configuration
const logger = {
    info: (msg) => console.log('🔥', '\x1b[36m', msg, '\x1b[0m'),
    success: (msg) => console.log('✨', '\x1b[32m', msg, '\x1b[0m'),
    warning: (msg) => console.log('⚠️', '\x1b[33m', msg, '\x1b[0m'),
    error: (msg) => console.log('💥', '\x1b[31m', msg, '\x1b[0m'),
    title: (msg) => console.log('\n📚', '\x1b[1m\x1b[35m', msg, '\x1b[0m\n'),
    progress: (current, total, msg) => {
        const percent = (current / total * 100).toFixed(1);
        console.log(`🔄 [${current}/${total}] ${percent}% - ${msg}`);
    }
};

const creds = { // Credentials for MangaDex
    grant_type: process.env.MANGADEX_GRANT_TYPE,
    username: process.env.MANGADEX_USERNAME,
    password: process.env.MANGADEX_PASSWORD,
    client_id: process.env.MANGADEX_CLIENT_ID,
    client_secret: process.env.MANGADEX_CLIENT_SECRET
}

async function updateMangaStatus(mangaId, status, accessToken) {
    try {
        const resp = await axios({
            method: 'POST',
            url: `https://api.mangadex.org/manga/${mangaId}/status`,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`,
                'User-Agent': USER_AGENT
            },
            data: {
                status: status
            }
        });
        logger.success(`Status updated for manga ${mangaId}: ${status}`);
        return resp.data.result;
    } catch (error) {
        logger.error(`Failed to update status for manga ${mangaId}: ${error.message}`);
        return null;
    }
}

async function findManga(mangaTitle, targetStatus, accessToken) {
    const cleanTitle = mangaTitle.toLowerCase().replace(/[^a-z0-9\s]/g, '');
    const titleTokens = cleanTitle.split(' ').filter(token => token.length > 2);
    logger.info(`Searching for: ${mangaTitle}`);
    logger.info(`Search tokens: ${titleTokens.join(', ')}`);

    const titleQuery = titleTokens.join(',');
    //console.log('\x1b[36m%s\x1b[0m', 'Query:', titleQuery);
    const response = await fetch(`https://api.mangadex.org/manga?limit=100&title=${titleQuery}`, {
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'User-Agent': USER_AGENT
        },
    });

    const data = await response.json();
    
    if (data.data) {
        const matches = data.data.map(manga => {
            // Get all available titles in different languages
            const allTitles = [
                manga.attributes.title.en,
                manga.attributes.title.ja,
                manga.attributes.title.ja_ro,
                ...Object.values(manga.attributes.altTitles || {}).map(t => Object.values(t)[0])
            ].filter(Boolean); // Remove undefined/null titles

            // Find the best matching title among all available titles
            const titleMatches = allTitles.map(title => {
                const mangaCleanTitle = title.toLowerCase().replace(/[^a-z0-9\s]/g, '');
                const mangaTokens = mangaCleanTitle.split(' ').filter(token => token.length > 2);
                
                // Calculate token similarity
                const commonTokens = titleTokens.filter(token => 
                    mangaTokens.some(mt => mt.includes(token) || token.includes(mt))
                );
                const tokenSimilarity = commonTokens.length / Math.max(titleTokens.length, mangaTokens.length);

                // Calculate string similarity (for short titles or exact matches)
                const stringSimilarity = calculateStringSimilarity(cleanTitle, mangaCleanTitle);

                // Use the higher of the two similarity measures
                const similarity = Math.max(tokenSimilarity, stringSimilarity);

                return {
                    title,
                    mangaTokens,
                    commonTokens,
                    similarity
                };
            });

            // Get the best matching title
            const bestMatch = titleMatches.reduce((best, current) => 
                current.similarity > best.similarity ? current : best
            );

            //console.log('\x1b[33m%s\x1b[0m', `Manga:`, manga.attributes.title.en || allTitles[0]);
            //console.log('\x1b[32m%s\x1b[0m', `All titles:`, allTitles.join(' | '));
            //console.log('\x1b[35m%s\x1b[0m', `Best match:`, bestMatch.title);
            //console.log('\x1b[34m%s\x1b[0m', `Similarity: ${bestMatch.similarity.toFixed(2)}\n`);

            return {
                id: manga.id,
                title: manga.attributes.title.en || allTitles[0],
                similarity: bestMatch.similarity
            };
        }).filter(match => match.similarity > 0.3)
          .sort((a, b) => b.similarity - a.similarity);

        //logger.info(`Found ${matches.length} potential matches`);
        matches.forEach((match, i) => {
            //logger.info(`Match ${i + 1}: ${match.title} (Similarity: ${(match.similarity * 100).toFixed(1)}%)`);
        });

        if (matches.length > 0) {
            const bestMatch = matches[0];
            if (bestMatch.similarity > 0.5) { // Lowered threshold slightly
                logger.success(`Best match found: ${bestMatch.title}`);
                const mdStatus = convertMALStatusToMD(targetStatus);
                await updateMangaStatus(bestMatch.id, mdStatus, accessToken);
                return bestMatch.id;
            } else {
                logger.warning('No match with sufficient similarity found');
            }
        }
    }
    return null;
}

function calculateStringSimilarity(str1, str2) {
    // Simple Levenshtein distance-based similarity
    const maxLength = Math.max(str1.length, str2.length);
    if (maxLength === 0) return 0;
    
    let distance = 0;
    for (let i = 0; i < Math.min(str1.length, str2.length); i++) {
        if (str1[i] === str2[i]) distance++;
    }
    return distance / maxLength;
}

function convertMALStatusToMD(malStatus) {
    const statusMap = {
        'Reading': 'reading',
        'Completed': 'completed',
        'On-Hold': 'on_hold',
        'Dropped': 'dropped',
        'Plan to Read': 'plan_to_read',
        '6': 'plan_to_read'  // Default for unknown status
    };
    return statusMap[malStatus] || 'plan_to_read';
}

async function cleanupMangaStatuses(processedManga, accessToken) {
    logger.title('Starting Cleanup Process');
    for (const manga of processedManga) {
        try {
            logger.info(`Cleaning up: ${manga.title}`);
            await updateMangaStatus(manga.id, null, accessToken);
            await new Promise(resolve => setTimeout(resolve, 200)); // Small delay between cleanup requests
        } catch (error) {
            logger.error(`Cleanup failed for ${manga.title}: ${error.message}`);
        }
    }
    logger.success('Cleanup complete! 🎉');
}

async function main() {
    try {
        logger.title('Starting MangaDex Import Process');
        const requiredEnvVars = ['MANGADEX_GRANT_TYPE', 'MANGADEX_USERNAME', 'MANGADEX_PASSWORD', 'MANGADEX_CLIENT_ID', 'MANGADEX_CLIENT_SECRET'];
        const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);
        
        if (missingEnvVars.length > 0) {
            throw new Error(`Missing required environment variables: ${missingEnvVars.join(', ')}`);
        }

        logger.info('Loading XML file...');
        // Get data from export.xml
        const exportXml = join(__dirname, 'export.xml');
        const exportXmlData = await fs.readFile(exportXml, 'utf8');

        logger.info('Parsing manga list...');
        // Split all manga into categories
        const parser = new xml2js.Parser();
        const result = await parser.parseStringPromise(exportXmlData);
        
        const mangaList = result.myanimelist.manga;
        const categories = {
            Reading: [],
            Completed: [],
            OnHold: [],
            Dropped: [],
            'Plan to Read': []
        };

        // Map MAL status to our categories
        mangaList.forEach(manga => {
            const status = manga.my_status[0];
            const title = manga.manga_title[0].trim();
            const chapters = manga.my_read_chapters[0];
            
            switch(status) {
                case 'Reading':
                    categories.Reading.push({ title, chapters });
                    break;
                case 'Completed':
                    categories.Completed.push({ title, chapters });
                    break;
                case 'On-Hold':
                    categories.OnHold.push({ title, chapters });
                    break;
                case 'Dropped':
                    categories.Dropped.push({ title, chapters });
                    break;
                case '6':
                    categories["Plan to Read"].push({ title, chapters });
                    break;
                default:
                    categories["Plan to Read"].push({ title, chapters });
            }
        });

        logger.title('Manga Statistics');
        Object.entries(categories).forEach(([category, items]) => {
            logger.info(`${category}: ${items.length} manga`);
        });

        logger.info('Connecting to MangaDex...');
        // Connect to mangadex
        const resp = await axios({
            method: 'POST',
            url: `https://auth.mangadex.org/realms/mangadex/protocol/openid-connect/token`,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': USER_AGENT
            },
            data: new URLSearchParams(creds).toString()
        });

        // Set the access token
        const accessToken = resp.data.access_token;
        const processedManga = [];

        // Process manga by category
        for (const [category, mangas] of Object.entries(categories)) {
            logger.title(`Processing ${category} category`);
            let processed = 0;
            for (const manga of mangas) {
                processed++;
                logger.progress(processed, mangas.length, manga.title);
                const mangaId = await findManga(manga.title, category, accessToken);
                if (mangaId) {
                    processedManga.push({
                        title: manga.title,
                        id: mangaId,
                        status: category
                    });
                }
                // Rate limiting
                await new Promise(resolve => setTimeout(resolve, 250));
            }
        }

        logger.success(`Successfully processed ${processedManga.length} manga`);
        logger.warning('Test will clean up manga statuses in 2 minutes...');

        // Set cleanup timeout
        // setTimeout(async () => {
        //     try {
        //         await cleanupMangaStatuses(processedManga, accessToken);
        //     } catch (error) {
        //         logger.error('Error during cleanup:', error.message);
        //     }
        // }, 2 * 60 * 1000); // 2 minutes

    } catch (error) {
        logger.error('Error:', error.message);
        if (error.response) {
            logger.error('Response data:', error.response.data);
        }
    }
}

main();