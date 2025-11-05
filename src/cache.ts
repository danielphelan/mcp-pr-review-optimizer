/**
 * Caching layer for GitHub API data
 */

import NodeCache from 'node-cache';
import { CacheEntry } from './types.js';

// Cache TTLs in seconds
export const CACHE_TTL = {
  EXPERTISE: 24 * 60 * 60,      // 24 hours
  WORKLOAD: 60 * 60,             // 1 hour
  PR_DATA: 15 * 60,              // 15 minutes
  REALTIME: 0,                   // No cache
} as const;

/**
 * Simple in-memory cache with TTL support
 */
export class Cache {
  private cache: NodeCache;

  constructor() {
    this.cache = new NodeCache({
      stdTTL: CACHE_TTL.PR_DATA,
      checkperiod: 120,
      useClones: false,
    });
  }

  /**
   * Get a value from cache
   */
  get<T>(key: string): T | undefined {
    return this.cache.get<T>(key);
  }

  /**
   * Set a value in cache with optional TTL
   */
  set<T>(key: string, value: T, ttl?: number): boolean {
    if (ttl === 0) {
      return false; // Don't cache if TTL is 0
    }
    return this.cache.set(key, value, ttl || CACHE_TTL.PR_DATA);
  }

  /**
   * Delete a value from cache
   */
  del(key: string): number {
    return this.cache.del(key);
  }

  /**
   * Clear all cache entries
   */
  flush(): void {
    this.cache.flushAll();
  }

  /**
   * Get or set a value using a factory function
   */
  async getOrSet<T>(
    key: string,
    factory: () => Promise<T>,
    ttl?: number
  ): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) {
      return cached;
    }

    const value = await factory();
    this.set(key, value, ttl);
    return value;
  }
}

// Singleton cache instance
export const cache = new Cache();
