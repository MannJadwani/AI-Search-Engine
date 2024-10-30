export interface SearchResult {
    title: string;
    url: string;
    snippet: string;
  }
  
  export interface SearchResponse {
    query: string;
    answer: string;
    citations: string[];
    searchQueriesUsed: string[];
  }
  