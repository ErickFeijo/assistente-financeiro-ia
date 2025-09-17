
import { openDB, DBSchema, IDBPDatabase } from 'idb';

const DB_NAME = 'FinancialAssistantDB';
const DB_VERSION = 1;
const BUDGETS_STORE = 'budgets';
const EXPENSES_STORE = 'expenses';

interface MyDB extends DBSchema {
  [BUDGETS_STORE]: {
    key: string;
    value: any;
  };
  [EXPENSES_STORE]: {
    key: string;
    value: any;
    indexes: { 'month': string };
  };
}

let dbPromise: Promise<IDBPDatabase<MyDB>>;

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB<MyDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(BUDGETS_STORE)) {
          db.createObjectStore(BUDGETS_STORE);
        }
        if (!db.objectStoreNames.contains(EXPENSES_STORE)) {
          const expenseStore = db.createObjectStore(EXPENSES_STORE, { keyPath: 'id' });
          expenseStore.createIndex('month', 'month');
        }
      },
    });
  }
  return dbPromise;
}

export async function getBudgets(month: string): Promise<any> {
  const db = await getDb();
  return db.get(BUDGETS_STORE, month);
}

export async function saveBudgets(month: string, budgets: any): Promise<void> {
  const db = await getDb();
  await db.put(BUDGETS_STORE, budgets, month);
}

export async function getExpenses(month: string): Promise<any[]> {
  const db = await getDb();
  return db.getAllFromIndex(EXPENSES_STORE, 'month', month);
}

export async function getAllExpenses(): Promise<any[]> {
  const db = await getDb();
  return db.getAll(EXPENSES_STORE);
}

export async function saveExpense(expense: any): Promise<void> {
  const db = await getDb();
  await db.put(EXPENSES_STORE, expense);
}

export async function deleteExpense(expenseId: string): Promise<void> {
  const db = await getDb();
  await db.delete(EXPENSES_STORE, expenseId);
}

export async function clearAllData(): Promise<void> {
    const db = await getDb();
    await db.clear(BUDGETS_STORE);
    await db.clear(EXPENSES_STORE);
}

export async function deleteCategoryFromDB(category: string, month: string): Promise<void> {
    const db = await getDb();
    const budgets = await getBudgets(month);
    if (budgets && budgets[category]) {
        delete budgets[category];
        await saveBudgets(month, budgets);
    }

    const expenses = await getExpenses(month);
    const tx = db.transaction(EXPENSES_STORE, 'readwrite');
    const store = tx.objectStore(EXPENSES_STORE);
    const promises = expenses
        .filter(expense => expense.category === category)
        .map(expense => store.delete(expense.id));
    await Promise.all([...promises, tx.done]);
}
