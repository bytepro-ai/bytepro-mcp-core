import { PostgresAdapter } from './postgres.js';
import { logger } from '../utils/logger.js';

/**
 * Adapter registry for managing database adapters
 * Selects appropriate adapter based on configuration
 */
export class AdapterRegistry {
  constructor() {
    this.adapters = new Map();
    this.activeAdapter = null;

    // Register available adapters
    this.registerAdapter('postgres', PostgresAdapter);

    logger.info({ adapters: Array.from(this.adapters.keys()) }, 'Adapter registry initialized');
  }

  /**
   * Register an adapter class
   * @param {string} name - Adapter name
   * @param {Class} AdapterClass - Adapter class constructor
   */
  registerAdapter(name, AdapterClass) {
    this.adapters.set(name, AdapterClass);
    logger.debug({ adapter: name }, 'Adapter registered');
  }

  /**
   * Initialize and activate an adapter
   * @param {string} name - Adapter name
   * @param {Object} config - Adapter configuration
   * @returns {Promise<BaseAdapter>} Initialized adapter instance
   */
  async initializeAdapter(name, config) {
    const AdapterClass = this.adapters.get(name);

    if (!AdapterClass) {
      throw new Error(`Adapter "${name}" not found. Available: ${Array.from(this.adapters.keys()).join(', ')}`);
    }

    try {
      const adapter = new AdapterClass(config);
      await adapter.connect();

      this.activeAdapter = adapter;

      logger.info({ adapter: name }, 'Adapter initialized and activated');

      return adapter;
    } catch (error) {
      logger.error({ adapter: name, error: error.message }, 'Failed to initialize adapter');
      throw error;
    }
  }

  /**
   * Get the active adapter
   * @returns {BaseAdapter} Active adapter instance
   */
  getAdapter() {
    if (!this.activeAdapter) {
      throw new Error('No adapter is active. Call initializeAdapter() first.');
    }

    return this.activeAdapter;
  }

  /**
   * Check if an adapter is available
   * @param {string} name - Adapter name
   * @returns {boolean} True if adapter is registered
   */
  hasAdapter(name) {
    return this.adapters.has(name);
  }

  /**
   * List all registered adapters
   * @returns {Array<string>} List of adapter names
   */
  listAdapters() {
    return Array.from(this.adapters.keys());
  }

  /**
   * Shutdown the active adapter
   */
  async shutdown() {
    if (this.activeAdapter) {
      try {
        await this.activeAdapter.disconnect();
        logger.info('Adapter shutdown complete');
      } catch (error) {
        logger.error({ error: error.message }, 'Error during adapter shutdown');
      } finally {
        this.activeAdapter = null;
      }
    }
  }
}

// Export singleton instance
export const adapterRegistry = new AdapterRegistry();

export default adapterRegistry;
