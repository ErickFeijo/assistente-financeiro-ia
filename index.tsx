import { GoogleGenAI } from '@google/genai';
import { useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { clearAllData, deleteCategoryFromDB, deleteExpense, getBudgets, getExpenses, getAllExpenses, saveBudgets, saveExpense } from './db';

// --- TYPES ---
type MainView = 'summary' | 'entries' | 'assistant';

interface Budget {
  [category: string]: number;
}

interface Expense {
  id: string;
  category: string;
  amount: number;
  date: string;
  month: string;
  description?: string;
  installmentGroupId?: string;
  installmentInfo?: string;
}

interface ChatMessage {
  role: 'user' | 'model';
  text: string;
  images?: string[];
}

/** ===== Novo contrato p/ inclusão de despesas (IA → App) ===== */
type AddExpensePayload = {
  expenses: ExpenseIntent[];
};

type ExpenseIntent = {
  category: string;            // deve existir em budgets
  description?: string;

  // Caso simples (sem parcelamento)
  amount?: number;

  // Caso parcelado (usa um dos dois campos de valor)
  installments?: {
    count: number;                 // >= 2
    amountPerInstallment?: number; // valor da parcela
    totalAmount?: number;          // valor total (app divide)
    baseMonth?: 'viewed' | 'current'; // mês base para gerar (default 'viewed')
    startOffsetMonths?: number;    // 0 = mês base; 1 = mês seguinte... (default 0)
  };
};

// --- HELPERS ---
const IS_DEBUG_MODE = new URLSearchParams(window.location.search).get('debug') === 'true';

const formatCurrency = (value: number, decimals = false) => {
  return value.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: decimals ? 2 : 0,
    maximumFractionDigits: decimals ? 2 : 0,
  });
};

const getMonthYear = (date = new Date()) => `${date.getFullYear()}-${date.getMonth() + 1}`;

const formatMonthYear = (monthKey: string, short = false) => {
  const [year, month] = monthKey.split('-');
  const date = new Date(parseInt(year), parseInt(month) - 1);
  const options: Intl.DateTimeFormatOptions = short
    ? { month: 'short', year: 'numeric' }
    : { month: 'long', year: 'numeric' };
  let formatted = date.toLocaleDateString('pt-BR', options);
  return formatted.charAt(0).toUpperCase() + formatted.slice(1);
};

// === Month helpers para parcelamento (APP calcula meses localmente) ===
const addMonthsToMonthKey = (monthKey: string, offset: number) => {
  const [y, m] = monthKey.split('-').map(Number);
  const d = new Date(y, (m - 1) + offset, 1);
  return `${d.getFullYear()}-${d.getMonth() + 1}`;
};

// Divide total em N parcelas, distribuindo centavos
const splitAmountIntoInstallments = (total: number, count: number) => {
  const cents = Math.round(total * 100);
  const base = Math.floor(cents / count);
  let remainder = cents - base * count;
  const arr = Array(count).fill(base).map((c, i) => (c + (i < remainder ? 1 : 0)) / 100);
  return arr;
};

// --- LOGGING HELPERS ---
const SESSION_ID = `session_${Date.now()}`;
const MAX_LOG_ENTRIES = 100;

const writeLog = (type: 'INTERACTION' | 'ERROR', data: object) => {
  if (!IS_DEBUG_MODE) return;
  try {
    const logEntry = {
      timestamp: new Date().toISOString(),
      sessionId: SESSION_ID,
      type,
      data,
    };

    const existingLogs = JSON.parse(localStorage.getItem('app_logs') || '[]');
    existingLogs.push(logEntry);

    if (existingLogs.length > MAX_LOG_ENTRIES) {
      existingLogs.splice(0, existingLogs.length - MAX_LOG_ENTRIES);
    }

    localStorage.setItem('app_logs', JSON.stringify(existingLogs));
  } catch (error) {
    console.error("Failed to write log:", error);
  }
};

const downloadLogs = () => {
  try {
    const logs = localStorage.getItem('app_logs');
    if (!logs || logs === '[]') {
      alert("Nenhum log para baixar.");
      return;
    }
    const blob = new Blob([logs], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `assistente-financeiro-logs-${new Date().toISOString()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error("Failed to download logs:", error);
    alert("Falha ao baixar os logs.");
  }
};


// --- AI INSTANCE & SYSTEM INSTRUCTION ---
const SYSTEM_INSTRUCTION = `
Você é um assistente de finanças pessoais amigável, inteligente e proativo. Sua tarefa é ajudar o usuário a gerenciar orçamentos e despesas de forma conversacional.

O estado atual das finanças é fornecido em JSON. Ele contém:
- 'budgets': Os orçamentos definidos para cada categoria.
- 'expenses': Uma lista de TODOS os lançamentos de despesas individuais do mês, cada um com 'category', 'amount', 'date' e opcionalmente 'description'. Use esta lista para identificar lançamentos específicos quando o usuário pedir para visualizar ou apagar.

Responda SEMPRE em formato JSON.

--- FLUXO DE CONVERSA ---

FLUXO 1: AÇÃO DIRETA (PARA SOLICITAÇÕES CLARAS)
Quando um pedido do usuário for claro e inequívoco e a categoria existir, execute a ação diretamente.

1.  **Ações Finais:** 'SET_BUDGET', 'ADD_EXPENSE'
2.  **Payload:** Para 'SET_BUDGET', use { "budget": { "<categoria>": valor }, "month"?: "YYYY-M" }.
    Para 'ADD_EXPENSE', use { "expenses": ExpenseIntent[] } (ver formato abaixo).
3.  **Response:** Mensagem de confirmação curta.

---

FLUXO 2: CONFIRMAÇÃO (PARA SOLICITAÇÕES AMBÍGUAS OU IMPORTANTES)
Use quando precisar de esclarecimentos (ex.: categoria não encontrada).
Responda com:
{
  "action": "CONFIRM_ACTION",
  "payload": { "actionToConfirm": "<AÇÃO_FINAL>", "data": <payload_parcial> },
  "response": "pergunta objetiva..."
}

---

FLUXO 3: VISUALIZAR OUTRO MÊS
{
  "action": "VIEW_PREVIOUS_MONTH",
  "payload": { "year": 2024, "month": 6 },
  "response": "Carregando dados de Junho/2024..."
}

---

FLUXO 4: SUGESTÃO DE ORÇAMENTO (PROATIVO)
Crie um plano completo e proponha via:
{
  "action": "CONFIRM_ACTION",
  "payload": { "actionToConfirm": "SET_BUDGET", "data": { "budget": {...}, "month"?: "YYYY-M" } },
  "response": "Sugestão..."
}

---

FLUXO 5: PROCESSAMENTO DE IMAGEM (NOTA FISCAL)
Extraia valor total e sugira categoria; peça confirmação com "CONFIRM_ACTION" → "ADD_EXPENSE".

---

FLUXO 6: EXCLUSÃO DE DADOS (sempre confirmar)
Use "CONFIRM_ACTION" com "actionToConfirm" ∈ { "DELETE_EXPENSE", "DELETE_CATEGORY", "CLEAR_ALL_DATA" }.

---

REGRAS IMPORTANTES
- VALIDAÇÃO DE CATEGORIA: ao adicionar despesa, a categoria DEVE existir em 'budgets'. Se não existir, use FLUXO 2.
- SEJA CONCISO, PROATIVO e mantenha os nomes das categorias exatamente como estão.
- SEMPRE responda com JSON válido.

---

FLUXO 7: LANÇAMENTO PARCELADO (NOVA REGRA — PRIORIDADE)
- NUNCA envie 'month', 'installmentGroupId' ou 'installmentInfo' (o app calcula).
- Sempre responda com "action": "ADD_EXPENSE" e "payload.expenses" contendo objetos "ExpenseIntent".
- Formatos:

  **Parcelado:**
  {
    "category": "...",
    "description": "...",
    "installments": {
      "count": <n>=2..,
      // use UM dos dois abaixo:
      "amountPerInstallment": <valor_da_parcela>,
      "totalAmount": <valor_total>,
      // opcionais:
      "baseMonth": "viewed" | "current",
      "startOffsetMonths": <int>=0
    }
  }

  **Simples:**
  { "category": "...", "description": "...", "amount": <valor> }

- Exemplo (3x de 100):
{
  "action": "ADD_EXPENSE",
  "payload": {
    "expenses": [
      { "category": "Dogs 🐶", "description": "Ração", "installments": { "count": 3, "amountPerInstallment": 100, "baseMonth": "viewed", "startOffsetMonths": 0 } }
    ]
  },
  "response": "Anotado! 3x de R$ 100 em Dogs 🐶."
}

- Exemplo (10x total 4000):
{
  "action": "ADD_EXPENSE",
  "payload": {
    "expenses": [
      { "category": "Lazer 🎉", "description": "PS5", "installments": { "count": 10, "totalAmount": 4000 } }
    ]
  },
  "response": "Ok, 10x a partir deste mês em Lazer 🎉."
}
`;
const ai = new GoogleGenAI({ apiKey: "AIzaSyBodxRZLyiZuSlCE4HBSv2QtmGQnk71Umc" });

// --- SVG ICONS ---
const PlusIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 12h14"/>
    <path d="M12 5v14"/>
  </svg>
);

const CameraIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/>
    <circle cx="12" cy="13" r="3"/>
  </svg>
);

const SendIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 2 11 13"/>
    <path d="m22 2-7 20-4-9-9-4 20-7z"/>
  </svg>
);

const MenuIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="1" />
    <circle cx="12" cy="5" r="1" />
    <circle cx="12" cy="19" r="1" />
  </svg>
);

const TypingIndicator = () => (
  <div className="typing-indicator">
    <span></span>
    <span></span>
    <span></span>
  </div>
);

// --- COMPONENTS ---

const DropdownMenu = ({ children, onClose }: { children: React.ReactNode, onClose: () => void }) => {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [onClose]);

  return (
    <div ref={menuRef} className="dropdown-menu">
      {children}
    </div>
  );
};

const AppHeader = ({ viewedMonth, onMonthChange, currentMonth }: {
  viewedMonth: string;
  onMonthChange: (direction: 'prev' | 'next') => void;
  currentMonth: string;
}) => {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const isCurrentMonth = viewedMonth === currentMonth;

  return (
    <header className="app-header">
      <div className="header-left">
        <h1 className="app-title">AF</h1>
      </div>
      <div className="header-center">
        <div className="month-switcher">
          <button onClick={() => onMonthChange('prev')} aria-label="Mês anterior" className="month-switcher-button">‹</button>
          <span className="month-switcher-label">{formatMonthYear(viewedMonth, true)}</span>
          <button onClick={() => onMonthChange('next')} disabled={isCurrentMonth} aria-label="Próximo mês" className="month-switcher-button">›</button>
        </div>
      </div>
      <div className="header-right">
        {IS_DEBUG_MODE && (
          <div className="header-menu-container">
            <button onClick={() => setIsMenuOpen(!isMenuOpen)} className="month-switcher-button" aria-label="Menu">
              <MenuIcon />
            </button>
            {isMenuOpen && (
              <DropdownMenu onClose={() => setIsMenuOpen(false)}>
                <button onClick={downloadLogs} className="dropdown-menu-item">
                  Baixar Logs de Diagnóstico
                </button>
              </DropdownMenu>
            )}
          </div>
        )}
      </div>
    </header>
  );
};

const SegmentedControl = ({ selected, onSelect }: { selected: MainView, onSelect: (view: MainView) => void }) => {
  const views: MainView[] = ['summary', 'entries', 'assistant'];
  const labels: { [key in MainView]: string } = { summary: 'Resumo', entries: 'Lançamentos', assistant: 'Assistente' };
  return (
    <nav className="segmented-control">
      {views.map(view => (
        <button key={view} className={`segment-button ${selected === view ? 'active' : ''}`} onClick={() => onSelect(view)} aria-pressed={selected === view}>
          {labels[view]}
        </button>
      ))}
    </nav>
  );
};

const KpiCard = ({ title, value, highlight = false }: { title: string, value: string, highlight?: boolean }) => (
  <div className={`kpi-card ${highlight ? 'kpi-card-highlight' : ''}`}>
    <span className="kpi-title">{title}</span>
    <span className="kpi-value">{value}</span>
  </div>
);

const CategoryCard = ({ category, budget, spent, onLongPress }: { category: string, budget: number, spent: number, onLongPress: (category: string) => void }) => {
  const longPressTimer = useRef<number | null>(null);

  const handleMouseDown = () => {
    longPressTimer.current = window.setTimeout(() => {
      onLongPress(category);
    }, 2000);
  };

  const handleMouseUp = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
    }
  };

  if (budget === 0) {
    return (
      <div className="category-card empty p-4 shadow-sm" onMouseDown={handleMouseDown} onMouseUp={handleMouseUp} onTouchStart={handleMouseDown} onTouchEnd={handleMouseUp}>
        <span className="category-title">{category}</span>
        <button className="define-budget-cta">Definir orçamento</button>
      </div>
    )
  }
  const percentage = budget > 0 ? (spent / budget) * 100 : 0;
  const remaining = budget - spent;
  const isOverBudget = percentage > 100;
  let progressColor = 'var(--success-color)';
  if (isOverBudget) progressColor = 'var(--danger-color)';
  else if (percentage > 70) progressColor = 'var(--warning-color)';

  return (
    <div className="category-card p-4 shadow-sm" onMouseDown={handleMouseDown} onMouseUp={handleMouseUp} onTouchStart={handleMouseDown} onTouchEnd={handleMouseUp}>
      <div className="card-header">
        <span className="category-title">{category}</span>
      </div>
      <div className="progress-bar-container">
        <div className="progress-bar">
          <div className="progress-bar-fill" style={{ width: `${Math.min(percentage, 100)}%`, backgroundColor: progressColor }}></div>
        </div>
        <span className="progress-percentage">{percentage.toFixed(0)}%</span>
      </div>
      <div className="card-footer">
        <span className="progress-label">{formatCurrency(spent)} de {formatCurrency(budget)}</span>
        {isOverBudget ? (
          <span className="chip over-budget">Estourou +{formatCurrency(spent - budget)}</span>
        ) : (
          <span className="chip remaining">Ainda tem {formatCurrency(remaining)}</span>
        )}
      </div>
    </div>
  );
};

const AddCategoryCard = ({ onClick }: { onClick: () => void }) => (
  <div className="category-card add-category-card" onClick={onClick}>
    <PlusIcon />
  </div>
);

const FloatingActionButton = ({ onClick }: { onClick: () => void }) => (
  <button className="fab" onClick={onClick} aria-label="Adicionar novo lançamento">
    <PlusIcon />
  </button>
);

const SummaryView = ({ budgets, expenses, viewedMonth, onAddCategory, onEditCategory }: { budgets: Budget, expenses: Expense[], viewedMonth: string, onAddCategory: () => void, onEditCategory: (category: string) => void }) => {
  const totalBudget = Object.values(budgets).reduce((sum, amount) => sum + amount, 0);
  const totalSpent = expenses.reduce((sum, expense) => sum + expense.amount, 0);
  const totalAvailable = totalBudget - totalSpent;
  const calculateSpentPerCategory = (category: string) => expenses.filter(e => e.category.toLowerCase() === category.toLowerCase()).reduce((sum, e) => sum + e.amount, 0);
  const budgetKeys = Object.keys(budgets);

  return (
    <div className="view-container summary-view">
      {budgetKeys.length > 0 ? (
        <div className="kpi-container">
          <div className="kpi-row">
            <KpiCard title="Gasto no mês" value={formatCurrency(totalSpent)} />
            <KpiCard title="Orçado" value={formatCurrency(totalBudget)} />
          </div>
          <div className="kpi-row">
            <KpiCard title="Ainda tem" value={formatCurrency(totalAvailable)} highlight />
          </div>
        </div>
      ) : (
        <div className="view-container empty-state">
          <p>Nenhum orçamento definido para {formatMonthYear(viewedMonth)}.</p>
          <p>Use o assistente ou adicione uma categoria abaixo.</p>
        </div>
      )}
      <div className="category-cards-container gap-3">
        {budgetKeys.map(category => (
          <CategoryCard key={category} category={category} budget={budgets[category]} spent={calculateSpentPerCategory(category)} onLongPress={onEditCategory} />
        ))}
        <AddCategoryCard onClick={onAddCategory} />
      </div>
    </div>
  );
};

const AssistantView = ({ messages, onSendMessage, isLoading }: { messages: ChatMessage[], onSendMessage: (msg: string, images?: File[]) => void, isLoading: boolean }) => {
  const [input, setInput] = useState('');
  const handleSuggestionClick = (suggestion: string, event: React.MouseEvent<HTMLButtonElement>) => {
    setInput(suggestion);
    event.currentTarget.blur();
  };

  return (
    <div className="view-container assistant-view">
      <div className="assistant-greeting"><p>Olá! Como posso ajudar hoje?</p></div>
      <div className="suggestion-chips">
        <button onClick={(e) => handleSuggestionClick('Definir orçamentos para o mês', e)}>Definir orçamentos</button>
        <button onClick={(e) => handleSuggestionClick('Adicionar gasto de R$50 em mercado', e)}>Adicionar gasto</button>
        <button onClick={(e) => handleSuggestionClick('Quais categorias estão no vermelho?', e)}>Ver categorias no vermelho</button>
      </div>
      <ChatInterface messages={messages} onSendMessage={onSendMessage} isLoading={isLoading} input={input} setInput={setInput} />
    </div>
  );
};

const SwipeableListItem = ({ children, onDelete }: { children: React.ReactNode, onDelete: () => void }) => {
  const itemRef = useRef<HTMLLIElement>(null);
  const [x, setX] = useState(0);
  const [isSwiping, setIsSwiping] = useState(false);
  const startX = useRef(0);

  const handleSwipeStart = (clientX: number) => {
    if (itemRef.current) {
      itemRef.current.style.transition = 'none';
      startX.current = clientX;
      setIsSwiping(true);
    }
  };

  const handleSwipeMove = (clientX: number) => {
    if (!isSwiping) return;
    const deltaX = clientX - startX.current;
    const newX = Math.min(0, Math.max(-100, deltaX));
    setX(newX);
  };

  const handleSwipeEnd = () => {
    if (!isSwiping) return;
    setIsSwiping(false);
    if (itemRef.current) {
      itemRef.current.style.transition = 'transform 0.3s ease';
      if (x < -50) {
        setX(-100);
      } else {
        setX(0);
      }
    }
  };

  const onMouseDown = (e: React.MouseEvent) => handleSwipeStart(e.clientX);
  const onMouseMove = (e: React.MouseEvent) => handleSwipeMove(e.clientX);
  const onMouseUp = () => handleSwipeEnd();
  const onMouseLeave = () => handleSwipeEnd();

  const onTouchStart = (e: React.TouchEvent) => handleSwipeStart(e.touches[0].clientX);
  const onTouchMove = (e: React.TouchEvent) => handleSwipeMove(e.touches[0].clientX);
  const onTouchEnd = () => handleSwipeEnd();

  const handleDelete = () => {
    setX(0);
    setTimeout(() => {
      onDelete();
    }, 300);
  };

  return (
    <li
      ref={itemRef}
      className="swipeable-list-item"
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseLeave}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      <div className="swipeable-actions">
        <button onClick={handleDelete} className="delete-button">Excluir</button>
      </div>
      <div className="swipeable-content" style={{ transform: `translateX(${x}px)` }}>
        {children}
      </div>
    </li>
  );
};

const ExpenseList = ({ expenses, allExpenses, onDeleteExpense }: { expenses: Expense[], allExpenses: Expense[], onDeleteExpense: (id: string) => void }) => {
  if (expenses.length === 0) {
    return (
      <div className="view-container empty-state"><p className="empty-list-message">Nenhum lançamento neste mês.</p></div>
    );
  }

  const truncateText = (text: string, maxLength: number) => {
    if (!text) return '';
    return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
  };

  const getInstallmentInfo = (expense: Expense, allExpenses: Expense[]): string | null => {
    if (expense.installmentInfo) {
      return expense.installmentInfo;
    }
    if (!expense.installmentGroupId) {
      return null;
    }
    const installmentGroup = allExpenses.filter(e => e.installmentGroupId === expense.installmentGroupId);
    installmentGroup.sort((a, b) => {
      const [yearA, monthA] = a.month.split('-').map(Number);
      const [yearB, monthB] = b.month.split('-').map(Number);
      if (yearA !== yearB) return yearA - yearB;
      return monthA - monthB;
    });
    const currentIndex = installmentGroup.findIndex(e => e.id === expense.id);
    if (currentIndex === -1) {
      return null;
    }
    return `${currentIndex + 1}/${installmentGroup.length}`;
  };

  return (
    <div className="view-container expense-list">
      <ul>
        {expenses.slice().reverse().map((expense) => {
          const installmentInfo = getInstallmentInfo(expense, allExpenses);

          if (expense.installmentGroupId || expense.installmentInfo) {
            console.log('Parcelled expense:', expense.category, expense.amount, expense.installmentGroupId, expense.installmentInfo, installmentInfo);
          }

          return (
            <SwipeableListItem key={expense.id} onDelete={() => onDeleteExpense(expense.id)}>
              <div
                className="expense-row"
                style={
                  (() => {
                    // cor de acento por categoria (estável)
                    let h = 0;
                    for (let i = 0; i < expense.category.length; i++) {
                      h = (h << 5) - h + expense.category.charCodeAt(i);
                      h |= 0;
                    }
                    const hue = Math.abs(h) % 360;
                    return {
                      // usa CSS vars para o item
                      // barra: forte | chip: bem claro
                      ['--item-accent' as any]: `hsl(${hue} 85% 45%)`,
                      ['--item-accent-bg' as any]: `hsl(${hue} 95% 95%)`,
                    };
                  })()
                }
              >
                <div className="expense-accent" />

                <div className="expense-left">
                  <div className="expense-title-row">
                    <span className="expense-category">{expense.category}</span>
                    {/* chip de parcela sobe pra linha do título */}
                    {installmentInfo && (
                      <span className="expense-installment-chip">{installmentInfo}</span>
                    )}
                  </div>

                  {expense.description && (
                    <div className="expense-description">{truncateText(expense.description, 38)}</div>
                  )}
                </div>

                <div className="expense-right">
                  <div className="expense-amount">{formatCurrency(expense.amount)}</div>
                  <div className="expense-date">{new Date(expense.date).toLocaleDateString('pt-BR')}</div>
                </div>
              </div>
            </SwipeableListItem>  
          );
        })}
      </ul>
    </div>
  );
};

const ChatInterface = ({ messages, onSendMessage, isLoading, input, setInput }: { messages: ChatMessage[]; onSendMessage: (msg: string, images?: File[]) => void; isLoading: boolean; input: string; setInput: (value: string) => void; }) => {
  const chatHistoryRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedImages, setSelectedImages] = useState<File[]>([]);

  useEffect(() => { if (chatHistoryRef.current) { chatHistoryRef.current.scrollTop = chatHistoryRef.current.scrollHeight; } }, [messages, isLoading]);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [input]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const fileToGenerativePart = async (file: File) => {
    const base64EncodedDataPromise = new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
      reader.readAsDataURL(file);
    });
    return {
      inlineData: { data: await base64EncodedDataPromise, mimeType: file.type },
    };
  };

  const handleImageSelection = async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) {
      const files = Array.from(event.target.files);
      setSelectedImages(files);
      if (!input.trim()) {
        onSendMessage("", files);
        setInput('');
        setSelectedImages([]);
        if(fileInputRef.current) fileInputRef.current.value = '';
      }
    }
  };

  const handleSubmit = () => {
    if ((input.trim() || selectedImages.length > 0) && !isLoading) {
      onSendMessage(input.trim(), selectedImages);
      setInput('');
      setSelectedImages([]);
      if(fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <div className="chat-container">
      <div className="chat-history" ref={chatHistoryRef}>
        {messages.map((msg, index) => (
          <div key={index} className={`message ${msg.role}`}>
            {msg.text.split('\n').map((line, i) => <p key={i}>{line}</p>)}
            {msg.images && (
              <div className="message-images">
                {msg.images.map((img, i) => <img key={i} src={img} alt="Uploaded content" />)}
              </div>
            )}
          </div>
        ))}
        {isLoading && <div className="message model thinking"><TypingIndicator /></div>}
      </div>
      <form onSubmit={(e) => { e.preventDefault(); handleSubmit(); }} className="chat-form">
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleImageSelection}
          multiple
          accept="image/*"
          style={{ display: 'none' }}
          id="image-upload"
        />
        <button type="button" className="icon-button" onClick={() => fileInputRef.current?.click()} aria-label="Adicionar imagem">
          <CameraIcon />
        </button>
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Digite seu comando..."
          aria-label="Chat input"
          disabled={isLoading}
          rows={1}
        />
        <button type="submit" className="icon-button" disabled={isLoading || (!input.trim() && selectedImages.length === 0)}>
          <SendIcon />
        </button>
      </form>
    </div>
  );
};

// --- MAIN APP COMPONENT ---

function App() {
  const [mainView, setMainView] = useState<MainView>(() => (localStorage.getItem('mainView') as MainView) || 'summary');
  const [isExpenseFormOpen, setIsExpenseFormOpen] = useState(false);
  const [isCategoryFormOpen, setIsCategoryFormOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    date: new Date().toISOString().split('T')[0],
    description: '',
    category: '',
    amount: '',
    isInstallment: false,
    installmentCount: '1'
  });
  const [currentMonth, setCurrentMonth] = useState(() => localStorage.getItem('currentMonth') || getMonthYear());
  const [viewedMonth, setViewedMonth] = useState(() => localStorage.getItem('viewedMonth') || getMonthYear());
  const [budgets, setBudgets] = useState<Budget>({});
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [allExpenses, setAllExpenses] = useState<Expense[]>([]);
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([{ role: 'model', text: 'Olá! Sou seu assistente financeiro.' }]);
  const [isLoading, setIsLoading] = useState(false);
  const [isFormSubmitting, setIsFormSubmitting] = useState(false);
  const [pendingAction, setPendingAction] = useState<any | null>(null);

  useEffect(() => {
    async function loadData() {
      const [savedBudgets, savedExpenses, allSavedExpenses] = await Promise.all([
        getBudgets(viewedMonth),
        getExpenses(viewedMonth),
        getAllExpenses()
      ]);
      setBudgets(savedBudgets || {});
      setExpenses(savedExpenses || []);
      setAllExpenses(allSavedExpenses || []);
    }
    loadData();
  }, [viewedMonth]);

  useEffect(() => { localStorage.setItem('mainView', mainView); }, [mainView]);
  useEffect(() => { localStorage.setItem('currentMonth', currentMonth); }, [currentMonth]);
  useEffect(() => { localStorage.setItem('viewedMonth', viewedMonth); }, [viewedMonth]);

  const handleMonthChange = (direction: 'prev' | 'next') => {
    const [year, month] = viewedMonth.split('-').map(Number);
    const newDate = new Date(year, month - (direction === 'prev' ? 2 : 0), 1);
    const newMonthKey = getMonthYear(newDate);
    const [currentYear, currentMonthNum] = currentMonth.split('-').map(Number);
    if (newDate.getFullYear() > currentYear || (newDate.getFullYear() === currentYear && newDate.getMonth() + 1 > currentMonthNum)) return;
    setViewedMonth(newMonthKey);
  };

  const handleDeleteExpense = async (expenseId: string) => {
    await deleteExpense(expenseId);
    setExpenses(prev => prev.filter(exp => exp.id !== expenseId));
    setAllExpenses(prev => prev.filter(exp => exp.id !== expenseId));
  };

  const fileToGenerativePart = async (file: File) => {
    const base64EncodedDataPromise = new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
      reader.readAsDataURL(file);
    });
    return {
      inlineData: { data: await base64EncodedDataPromise, mimeType: file.type },
    };
  };

  /** ===== Novo executor local de payload ADD_EXPENSE (sem IA calcular mês) ===== */
  const applyAddExpensePayload = async (payload: AddExpensePayload) => {
    if (!payload?.expenses?.length) return;

    let maxMonth = currentMonth;

    for (const req of payload.expenses) {
      // Validação local de categoria (melhor UX)
      if (!Object.keys(budgets).some(k => k.toLowerCase() === req.category.toLowerCase())) {
        setChatHistory(prev => [...prev, { role: 'model', text: `Categoria '${req.category}' não existe neste mês. Quer criá-la ou usar outra?` }]);
        continue;
      }

      const baseMonthSrc = req.installments?.baseMonth || 'viewed';
      const baseMonthKey = baseMonthSrc === 'current' ? currentMonth : viewedMonth;
      const startOffset = req.installments?.startOffsetMonths ?? 0;

      if (req.installments?.count && req.installments.count > 1) {
        // Parcelado
        const count = Number(req.installments.count);
        const groupId = `installment_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

        let perParcelAmounts: number[] | null = null;
        if (typeof req.installments.amountPerInstallment === 'number') {
          perParcelAmounts = Array(count).fill(Number(req.installments.amountPerInstallment));
        } else if (typeof req.installments.totalAmount === 'number') {
          perParcelAmounts = splitAmountIntoInstallments(Number(req.installments.totalAmount), count);
        }

        if (!perParcelAmounts) {
          setChatHistory(prev => [...prev, { role: 'model', text: `Não entendi o valor das parcelas em '${req.category}'. Informe total ou valor por parcela.` }]);
          continue;
        }

        for (let i = 0; i < count; i++) {
          const monthKey = addMonthsToMonthKey(baseMonthKey, startOffset + i);
          const processed: Expense = {
            id: `exp_${Date.now()}_${Math.random().toString(36).slice(2, 9)}_${i}`,
            category: req.category,
            amount: perParcelAmounts[i],
            month: monthKey,
            date: new Date().toISOString(),
            description: req.description,
            installmentGroupId: groupId,
            installmentInfo: `${i + 1}/${count}`,
          };
          await saveExpense(processed);
          if (processed.month === viewedMonth) setExpenses(prev => [...prev, processed]);
          setAllExpenses(prev => [...prev, processed]);

          const [ey, em] = processed.month.split('-').map(Number);
          const [cy, cm] = maxMonth.split('-').map(Number);
          if (ey > cy || (ey === cy && em > cm)) maxMonth = processed.month;
        }

      } else if (typeof req.amount === 'number') {
        // Simples
        const monthKey = addMonthsToMonthKey(baseMonthKey, startOffset);
        const processed: Expense = {
          id: `exp_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
          category: req.category,
          amount: Number(req.amount),
          month: monthKey,
          date: new Date().toISOString(),
          description: req.description,
        };
        await saveExpense(processed);
        if (processed.month === viewedMonth) setExpenses(prev => [...prev, processed]);
        setAllExpenses(prev => [...prev, processed]);

        const [ey, em] = processed.month.split('-').map(Number);
        const [cy, cm] = maxMonth.split('-').map(Number);
        if (ey > cy || (ey === cy && em > cm)) maxMonth = processed.month;

      } else {
        setChatHistory(prev => [...prev, { role: 'model', text: `Lançamento em '${req.category}' sem valor reconhecido.` }]);
      }
    }

    if (maxMonth !== currentMonth) setCurrentMonth(maxMonth);
  };

  /** ===== Chat com IA (texto livre, imagens, confirmações, etc.) ===== */
  const handleSendMessage = async (userInput: string, images?: File[]) => {
    setIsLoading(true);

    const imageParts = images ? await Promise.all(images.map(fileToGenerativePart)) : [];
    const imageUrls = images ? images.map(file => URL.createObjectURL(file)) : [];

    const userMessage: ChatMessage = { role: 'user', text: userInput, images: imageUrls };
    const newChatHistory = [...chatHistory, userMessage];
    setChatHistory(newChatHistory);

    const currentState = {
      budgets,
      expenses,
      viewedMonth,
      currentMonth,
    };

    const historyForPrompt = newChatHistory.map(msg => `${msg.role}: ${msg.text}`).join('\n');

    let prompt;
    if (pendingAction) {
      prompt = `
Histórico da conversa:
${historyForPrompt}

Contexto: O usuário está respondendo a uma pergunta de confirmação.
Ação pendente: ${JSON.stringify(pendingAction)}
Estado atual: ${JSON.stringify(currentState)}
Nova mensagem do usuário: "${userInput}"
      `;
    } else {
      prompt = `
Histórico da conversa:
${historyForPrompt}

Estado atual: ${JSON.stringify(currentState)}
Nova mensagem do usuário: "${userInput}"
      `;
    }

    try {
      const contents = [
        ...imageParts,
        { text: prompt }
      ];

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: contents,
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          responseMimeType: 'application/json',
        },
      });

      const aiResponseText = response.text;
      const aiResponseJson = JSON.parse(aiResponseText);

      writeLog('INTERACTION', {
        userInput,
        imageAttached: (images || []).length > 0,
        prompt,
        rawApiResponse: aiResponseText,
        parsedAction: aiResponseJson.action,
        payload: aiResponseJson.payload,
      });

      const { action, payload, response: textResponse } = aiResponseJson;

      const modelMessage: ChatMessage = { role: 'model', text: String(textResponse) };
      const finalHistory = [...newChatHistory, modelMessage];

      switch (action) {
        case 'CONFIRM_ACTION':
          setPendingAction(payload);
          break;

        case 'SET_BUDGET': {
          const monthToSet = payload.month || viewedMonth;
          const newBudgets = { ...budgets, ...payload.budget };
          await saveBudgets(monthToSet, newBudgets);
          if (monthToSet === viewedMonth) {
            setBudgets(newBudgets);
          }
          const [newYear, newMonth] = monthToSet.split('-').map(Number);
          const [latestYear, latestMonth] = currentMonth.split('-').map(Number);
          if (newYear > latestYear || (newYear === latestYear && newMonth > latestMonth)) {
            setCurrentMonth(monthToSet);
          }
          setPendingAction(null);
          break;
        }

        case 'ADD_EXPENSE': {
          // Novo contrato (sem month): aplicar localmente
          const looksOld = Array.isArray(payload?.expenses) && payload.expenses.some((e: any) => e?.month);
          if (looksOld) {
            // === Compatibilidade com payloads antigos ===
            const isInstallment = payload.expenses.some((exp: any) => exp.installmentGroupId);
            let maxMonth = currentMonth;
            const installmentGroupIdForGroup = isInstallment
              ? payload.expenses.find((exp: any) => exp.installmentGroupId)?.installmentGroupId
              : undefined;

            for (let i = 0; i < payload.expenses.length; i++) {
              const exp: any = payload.expenses[i];
              const monthToAdd = exp.month || viewedMonth;
              const installmentGroupId = isInstallment
                ? (exp.installmentGroupId || installmentGroupIdForGroup)
                : undefined;

              const processedExpense: Expense = {
                id: `exp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}_${i}`,
                category: exp.category,
                amount: exp.amount,
                month: monthToAdd,
                date: new Date().toISOString(),
                description: exp.description,
                installmentGroupId: installmentGroupId,
                installmentInfo: isInstallment && exp.installmentInfo ? exp.installmentInfo : undefined,
              };

              await saveExpense(processedExpense);
              if (processedExpense.month === viewedMonth) {
                setExpenses(prev => [...prev, processedExpense]);
              }
              setAllExpenses(prev => [...prev, processedExpense]);

              const [expYear, expMonth] = processedExpense.month.split('-').map(Number);
              const [currentMaxYear, currentMaxMonthNum] = maxMonth.split('-').map(Number);
              if (expYear > currentMaxYear || (expYear === currentMaxYear && expMonth > currentMaxMonthNum)) {
                maxMonth = processedExpense.month;
              }
            }
            if (maxMonth !== currentMonth) setCurrentMonth(maxMonth);
          } else {
            // === Novo fluxo ===
            await applyAddExpensePayload(payload as AddExpensePayload);
          }
          setPendingAction(null);
          break;
        }

        case 'DELETE_EXPENSE': {
          const { category: catToDelete, amount: amountToDelete } = payload;
          const expenseToDelete = expenses.find(expense => expense.category.toLowerCase() === catToDelete.toLowerCase() && expense.amount === amountToDelete);

          if (expenseToDelete) {
            await deleteExpense(expenseToDelete.id);
            setExpenses(prev => prev.filter(exp => exp.id !== expenseToDelete.id));
            setAllExpenses(prev => prev.filter(exp => exp.id !== expenseToDelete.id));
          }
          setPendingAction(null);
          break;
        }

        case 'NEXT_MONTH': {
          const [year, month] = viewedMonth.split('-').map(Number);
          const nextDate = new Date(year, month, 1);
          const newMonthKey = `${nextDate.getFullYear()}-${nextDate.getMonth() + 1}`;

          if (payload.copyBudgets) {
            const currentBudgets = await getBudgets(viewedMonth);
            if(currentBudgets) {
              await saveBudgets(newMonthKey, currentBudgets);
            }
          }
          setViewedMonth(newMonthKey);
          setCurrentMonth(newMonthKey);
          setPendingAction(null);
          break;
        }

        case 'VIEW_PREVIOUS_MONTH': {
          const { year: pYear, month: pMonth } = payload;
          setViewedMonth(`${pYear}-${pMonth}`);
          setPendingAction(null);
          break;
        }

        case 'CLEAR_ALL_DATA': {
          await clearAllData();
          localStorage.removeItem('mainView');
          localStorage.removeItem('currentMonth');
          localStorage.removeItem('viewedMonth');

          setBudgets({});
          setExpenses([]);
          setAllExpenses([]);

          const currentMonthKey = getMonthYear();
          setViewedMonth(currentMonthKey);
          setCurrentMonth(currentMonthKey);
          setPendingAction(null);
          break;
        }

        case 'DELETE_CATEGORY': {
          const { category: categoryToDelete } = payload;
          await deleteCategoryFromDB(categoryToDelete, viewedMonth);

          const updatedBudgets = { ...budgets };
          delete updatedBudgets[categoryToDelete];
          setBudgets(updatedBudgets);

          const updatedExpenses = expenses.filter(expense => expense.category.toLowerCase() !== categoryToDelete.toLowerCase());
          setExpenses(updatedExpenses);
          setAllExpenses(prev => prev.filter(expense => expense.category.toLowerCase() !== categoryToDelete.toLowerCase()));
          setPendingAction(null);
          break;
        }

        case 'CANCEL_ACTION':
        case 'GREETING':
        case 'UNKNOWN':
        default:
          setPendingAction(null);
          break;
      }

      setChatHistory(finalHistory);

    } catch (error) {
      console.error("Error calling Gemini API:", error);
      writeLog('ERROR', {
        userInput,
        prompt,
        error: {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
      });
      const errorMessage = "Desculpe, não consegui processar sua solicitação. Tente novamente.";
      setChatHistory(prev => [...prev, { role: 'model', text: errorMessage }]);
      setPendingAction(null);
    } finally {
      setIsLoading(false);
    }
  };

  const handleFormChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value, type } = e.target;
    const checked = (e.target as HTMLInputElement).checked;

    if (name === 'amount') {
      let formattedValue = value.replace(/[^0-9,]/g, '');
      const parts = formattedValue.split(',');
      if (parts.length > 2) {
        formattedValue = parts[0] + ',' + parts.slice(1).join('');
      }
      if (parts[1] && parts[1].length > 2) {
        formattedValue = parts[0] + ',' + parts[1].substring(0, 2);
      }
      setFormData(prev => ({ ...prev, [name]: formattedValue }));
    } else {
      setFormData(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
    }
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsFormSubmitting(true);
    try {
      if (formData.isInstallment) {
        const installmentCount = parseInt(formData.installmentCount);
        const total = parseFloat(formData.amount.replace(',', '.'));

        const payload: AddExpensePayload = {
          expenses: [{
            category: formData.category,
            description: formData.description || undefined,
            installments: {
              count: installmentCount,
              totalAmount: total,
              baseMonth: 'viewed',
              startOffsetMonths: 0
            }
          }]
        };

        await applyAddExpensePayload(payload);
        setChatHistory(prev => [...prev, { role: 'model', text: `Ok! Lancei ${installmentCount}x a partir deste mês em ${formData.category}.` }]);
      } else {
        const amount = parseFloat(formData.amount.replace(',', '.'));
        const payload: AddExpensePayload = {
          expenses: [{
            category: formData.category,
            description: formData.description || undefined,
            amount
          }]
        };
        await applyAddExpensePayload(payload);
        setChatHistory(prev => [...prev, { role: 'model', text: `Lancei ${formatCurrency(amount, true)} em ${formData.category}.` }]);
      }

      setIsExpenseFormOpen(false);
      setFormData({
        date: new Date().toISOString().split('T')[0],
        description: '',
        category: '',
        amount: '',
        isInstallment: false,
        installmentCount: '1'
      });
    } catch (error) {
      console.error("Error submitting form:", error);
    } finally {
      setIsFormSubmitting(false);
    }
  };

  const handleOpenAddCategory = () => {
    setEditingCategory(null);
    setIsCategoryFormOpen(true);
  };

  const handleOpenEditCategory = (category: string) => {
    setEditingCategory(category);
    setIsCategoryFormOpen(true);
  };

  const renderMainView = () => {
    switch (mainView) {
      case 'summary': return <SummaryView budgets={budgets} expenses={expenses} viewedMonth={viewedMonth} onAddCategory={handleOpenAddCategory} onEditCategory={handleOpenEditCategory} />;
      case 'entries': return <ExpenseList expenses={expenses} allExpenses={allExpenses} onDeleteExpense={handleDeleteExpense} />;
      case 'assistant': return <AssistantView messages={chatHistory} onSendMessage={handleSendMessage} isLoading={isLoading} />;
      default: return null;
    }
  };

  const AddExpenseForm = () => (
    <div className="modal-overlay">
      <div className="modal-content">
        <h2>Adicionar Lançamento</h2>
        <form onSubmit={handleFormSubmit}>
          <div className="form-group">
            <label htmlFor="date">Data:</label>
            <input
              type="date"
              id="date"
              name="date"
              value={formData.date}
              onChange={handleFormChange}
              required
              disabled={isFormSubmitting}
            />
          </div>

          <div className="form-group">
            <label htmlFor="category">Categoria:</label>
            <select
              id="category"
              name="category"
              value={formData.category}
              onChange={handleFormChange}
              required
              disabled={isFormSubmitting}
            >
              <option value="">Selecione uma categoria</option>
              {Object.keys(budgets).map(category => (
                <option key={category} value={category}>{category}</option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label htmlFor="description">Descrição:</label>
            <input
              type="text"
              id="description"
              name="description"
              value={formData.description}
              onChange={handleFormChange}
              placeholder="Descreva o lançamento (opcional)"
              disabled={isFormSubmitting}
            />
          </div>

          <div className="form-group">
            <label htmlFor="amount">Valor (R$):</label>
            <input
              type="text"
              id="amount"
              name="amount"
              value={formData.amount}
              onChange={handleFormChange}
              placeholder="0,00"
              required
              disabled={isFormSubmitting}
            />
          </div>

          <div className="form-group checkbox-group">
            <input
              type="checkbox"
              id="isInstallment"
              name="isInstallment"
              checked={formData.isInstallment}
              onChange={handleFormChange}
              disabled={isFormSubmitting}
            />
            <label htmlFor="isInstallment">Lançamento parcelado</label>
          </div>

          {formData.isInstallment && (
            <div className="form-group">
              <label htmlFor="installmentCount">Número de parcelas:</label>
              <select
                id="installmentCount"
                name="installmentCount"
                value={formData.installmentCount}
                onChange={handleFormChange}
                required
                disabled={isFormSubmitting}
              >
                {[...Array(24)].map((_, i) => (
                  <option key={i + 1} value={i + 1}>{i + 1}</option>
                ))}
              </select>
            </div>
          )}

          <div className="form-actions">
            <button type="button" onClick={() => setIsExpenseFormOpen(false)} disabled={isFormSubmitting}>Cancelar</button>
            <button type="submit" disabled={isFormSubmitting}>
              {isFormSubmitting ? "Adicionando..." : "Adicionar"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );

  const CategoryForm = ({
    isOpen,
    onClose,
    onSubmit,
    initialData,
  }: {
    isOpen: boolean;
    onClose: () => void;
    onSubmit: (data: { name: string; budget: number }) => void;
    initialData?: { name: string; budget: number };
  }) => {
    const [name, setName] = useState('');
    const [budget, setBudget] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);

    useEffect(() => {
      if (initialData) {
        setName(initialData.name);
        setBudget(initialData.budget.toString());
      } else {
        setName('');
        setBudget('');
      }
    }, [initialData]);

    if (!isOpen) return null;

    const handleSubmit = async (e: React.FormEvent) => {
      e.preventDefault();
      setIsSubmitting(true);
      await onSubmit({ name, budget: parseFloat(budget.replace(',', '.')) });
      setIsSubmitting(false);
      onClose();
    };

    return (
      <div className="modal-overlay">
        <div className="modal-content">
          <h2>{initialData ? 'Editar' : 'Adicionar'} Categoria</h2>
          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label htmlFor="category-name">Nome:</label>
              <input
                type="text"
                id="category-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                disabled={isSubmitting || !!initialData}
              />
            </div>
            <div className="form-group">
              <label htmlFor="category-budget">Orçamento (R$):</label>
              <input
                type="text"
                id="category-budget"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                placeholder="0,00"
                required
                disabled={isSubmitting}
              />
            </div>
            <div className="form-actions">
              <button type="button" onClick={onClose} disabled={isSubmitting}>
                Cancelar
              </button>
              <button type="submit" disabled={isSubmitting}>
                {isSubmitting ? 'Salvando...' : 'Salvar'}
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  };

  const handleCategoryFormSubmit = async (data: { name: string; budget: number }) => {
    const newBudgets = { ...budgets, [data.name]: data.budget };
    await saveBudgets(viewedMonth, newBudgets);
    setBudgets(newBudgets);
  };

  return (
    <div className="app-container">
      <AppHeader viewedMonth={viewedMonth} onMonthChange={handleMonthChange} currentMonth={currentMonth} />
      <SegmentedControl selected={mainView} onSelect={setMainView} />
      <main className="main-content">
        {renderMainView()}
        {isExpenseFormOpen && <AddExpenseForm />}
        <CategoryForm
          isOpen={isCategoryFormOpen}
          onClose={() => setIsCategoryFormOpen(false)}
          onSubmit={handleCategoryFormSubmit}
          initialData={editingCategory ? { name: editingCategory, budget: budgets[editingCategory] || 0 } : undefined}
        />
        {mainView === 'entries' && (
          <FloatingActionButton onClick={() => setIsExpenseFormOpen(true)} />
        )}
      </main>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
root.render(<App />);
