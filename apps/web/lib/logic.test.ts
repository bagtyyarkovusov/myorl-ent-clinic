import { describe, expect, it, vi } from "vitest";
import CatchAllPage from '../app/[locale]/[...slug]/page';

// Mock the Strapi fetch
vi.mock('../lib/strapi', () => ({
  fetchContentByPath: vi.fn(),
}));

import { fetchContentByPath } from '../lib/strapi';

describe("CatchAllPage Logic", () => {
  it("fetches and resolves service data correctly", async () => {
    const mockService = {
      type: "service",
      documentId: "service-123",
      title: "Test Service",
      body: "This is a test service body.",
      canonicalPath: "test-service",
    };
    
    (fetchContentByPath as any).mockResolvedValue(mockService);

    const params = Promise.resolve({ locale: 'el', slug: ['test-service'] });
    
    // We just execute the RSC (React Server Component) function
    const result = await CatchAllPage({ params });
    
    expect(fetchContentByPath).toHaveBeenCalledWith('el', 'test-service');
    expect(result).toBeDefined();
    
    // Verify it's a JSX element for a main tag (rough check for RSC output)
    expect((result as any).type).toBe('main');
  });

  it("fetches and resolves service category data correctly", async () => {
    const mockCategory = {
      type: "service-category",
      documentId: "cat-456",
      title: "Test Category",
      description: "Test Category Description",
      canonicalPath: "test-cat",
    };
    
    (fetchContentByPath as any).mockResolvedValue(mockCategory);

    const params = Promise.resolve({ locale: 'ru', slug: ['test-cat'] });
    
    const result = await CatchAllPage({ params });
    
    expect(fetchContentByPath).toHaveBeenCalledWith('ru', 'test-cat');
    expect(result).toBeDefined();
    expect((result as any).type).toBe('main');
  });
});
