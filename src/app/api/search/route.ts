import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import * as cheerio from 'cheerio';
import { SearchResult } from '@/types/search';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
  
});

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
};

async function generateSearchQueries(query: string): Promise<string[]> {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: "You are a search expert. Generate 3 specific search queries that would help answer the user's question. Format each query on a new line."
        },
        {
          role: "user",
          content: `Generate specific search queries to answer this question: ${query}`
        }
      ]
    });

    const content = response.choices[0].message.content;
    if (content) {
      return content.split('\n').filter(q => q.trim());
    } else {
      return [query];
    }
  } catch (error) {
    console.error('Error generating queries:', error);
    return [query];
  }
}

async function searchGoogle(query: string): Promise<SearchResult[]> {
  try {
    const encodedQuery = encodeURIComponent(query);
    const url = `https://www.google.com/search?q=${encodedQuery}&num=16`;
    
    const response = await fetch(url, { headers: HEADERS });
    if (!response.ok) throw new Error('Failed to fetch search results');
    
    const html = await response.text();
    const $ = cheerio.load(html);
    const results: SearchResult[] = [];

    // Find all search result divs
    $('div.g').each((_, element) => {
      try {
        const titleElement = $(element).find('h3');
        const linkElement = $(element).find('a').first();
        const snippetElement = $(element).find('div.VwiC3b');  // Google's snippet class

        const title = titleElement.text();
        const url = linkElement.attr('href');
        const snippet = snippetElement.text();

        // Only add results with valid URLs
        if (url && url.startsWith('http') && title && snippet) {
          results.push({
            title: title.trim(),
            url: url.trim(),
            snippet: snippet.trim()
          });
        }
      } catch (error) {
        console.error('Error parsing search result:', error);
      }
    });

    return results.slice(0, 8); // Limit to top 8 results
  } catch (error) {
    console.error('Error searching Google:', error);
    return [];
  }
}

async function extractContent(url: string): Promise<string> {
  try {
    const response = await fetch(url, { headers: HEADERS });
    if (!response.ok) throw new Error('Failed to fetch page content');
    
    const html = await response.text();
    const $ = cheerio.load(html);

    // Remove unwanted elements
    $('script, style, nav, header, footer, aside, iframe, img').remove();

    // Extract main content
    const contentSelectors = [
      'article',
      'main',
      '.content',
      '.post-content',
      '.article-content',
      '#content',
      '#main-content'
    ];

    let content = '';

    // Try specific content selectors first
    for (const selector of contentSelectors) {
      const element = $(selector);
      if (element.length > 0) {
        content = element.text().trim();
        break;
      }
    }

    // If no content found with specific selectors, try paragraphs
    if (!content) {
      const paragraphs = $('p')
        .map((_, el) => $(el).text().trim())
        .get()
        .filter(text => text.length > 50);  // Only keep substantial paragraphs
      
      content = paragraphs.join('\n\n');
    }

    // Clean up the text
    return content
      .replace(/\s+/g, ' ')  // Replace multiple spaces with single space
      .replace(/\n\s*\n/g, '\n\n')  // Replace multiple newlines with double newline
      .trim()
      .slice(0, 4000);  // Limit content length
  } catch (error) {
    console.error(`Error extracting content from ${url}:`, error);
    return '';
  }
}

async function synthesizeInformation(query: string, sources: SearchResult[]): Promise<[string, string[]]> {
  try {
    const sourceTexts: string[] = [];
    const citations: string[] = [];
    
    // Process each source with rate limiting
    for (const source of sources) {
      try {
        const content = await extractContent(source.url);
        if (content) {
          sourceTexts.push(`Content from ${source.url}:\n${content}`);
          citations.push(source.url);
        }
        if (source.snippet) {
          sourceTexts.push(`Snippet: ${source.snippet}`);
        }
        // Add a small delay between requests to be polite
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        console.error(`Error processing source ${source.url}:`, error);
      }
    }

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: "You are a research assistant. Synthesize the provided information to answer the user's question. Be specific and cite sources where possible. If information is incomplete or uncertain, acknowledge this."
        },
        {
          role: "user",
          content: `Question: ${query}\n\nSources:\n${sourceTexts.join('\n\n')}`
        }
      ]
    });

    return [response.choices[0].message.content ?? 'No content available', citations];
  } catch (error) {
    console.error('Error synthesizing information:', error);
    return ['Error synthesizing information.', []];
  }
}

export async function POST(request: Request) {
  try {
    const { query } = await request.json();
    
    // Add middleware check for rate limiting
    const ip = request.headers.get('x-forwarded-for') || 'unknown';
    const rateLimitKey = `search-${ip}`;
    
    const searchQueries = await generateSearchQueries(query);
    
    const allSources: SearchResult[] = [];
    for (const searchQuery of searchQueries) {
      const results = await searchGoogle(searchQuery);
      allSources.push(...results);
      // Add delay between searches to be polite to Google
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    const [answer, citations] = await synthesizeInformation(query, allSources);
    
    return NextResponse.json({
      query,
      answer,
      citations,
      searchQueriesUsed: searchQueries
    });
  } catch (error) {
    console.error('Error processing search:', error);
    return NextResponse.json(
      { error: 'Failed to process search' },
      { status: 500 }
    );
  }
}