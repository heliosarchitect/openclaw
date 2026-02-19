/**
 * Task-009: Cross-Domain Pattern Transfer — Extractor Registry
 *
 * Plugin registry for domain extractors. Engine discovers extractors at runtime.
 * Adding a new domain = drop a new file in extractors/, register it here.
 */

import type { DomainExtractor, DomainId, ExtractorRegistryI } from "./types.js";

export class ExtractorRegistry implements ExtractorRegistryI {
  private extractors = new Map<DomainId, DomainExtractor>();

  register(extractor: DomainExtractor): void {
    this.extractors.set(extractor.domain, extractor);
  }

  getAll(): DomainExtractor[] {
    return [...this.extractors.values()];
  }

  getByDomain(domain: DomainId): DomainExtractor | undefined {
    return this.extractors.get(domain);
  }

  get size(): number {
    return this.extractors.size;
  }
}
