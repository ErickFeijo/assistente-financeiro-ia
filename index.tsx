/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { GoogleGenAI } from '@google/genai';
import { useEffect, useState, useRef } from 'react';
import ReactDOM from 'react-dom/client';
import { getBudgets, saveBudgets, getExpenses, saveExpense, deleteExpense, clearAllData, deleteCategoryFromDB } from './db';

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
  installmentGroupId?: string;
  installmentInfo?: string;
}

interface ChatMessage {
  role: 'user' | 'model';
  text: string;
  images?: string[];
}

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
- 'expenses': Uma lista de TODOS os lançamentos de despesas individuais do mês, cada um com 'category', 'amount' e 'date'. Use esta lista para identificar lançamentos específicos quando o usuário pedir para visualizar ou apagar.

Responda SEMPRE em formato JSON.

--- FLUXO DE CONVERSA ---

FLUXO 1: AÇÃO DIRETA (PARA SOLICITAÇÕES CLARAS)
Quando um pedido do usuário for claro e inequívoco e a categoria existir, execute a ação diretamente.

1.  **Ações Finais:** 'SET_BUDGET', 'ADD_EXPENSE'
2.  **Payload:** Os dados para a ação. Para 
'SET_BUDGET',
 o payload é um objeto com a chave 
'budget'
. Para 
'ADD_EXPENSE',
 o payload é um objeto com a chave 
'expenses'
 (um array). Opcionalmente, inclua um campo 
'month'
 (formato 'YYYY-M') se a ação for para um mês diferente do 
'viewedMonth'
.
3.  **Response:** Uma mensagem de confirmação amigável e curta.
    -   Usuário: "adicione um gasto de 50 em {nome_da_categoria}"
    -   Sua resposta JSON:
        {
          "action": "ADD_EXPENSE",
          "payload": { "expenses": [{ "category": "{nome_da_categoria}", "amount": 50 }] },
          "response": "Anotado! Gasto de R$ 50 em 
'{nome_da_categoria}'
."
        }
    -   Usuário: "definir orçamento de 500 para {nome_da_categoria} em {mês}"
    -   Sua resposta JSON:
        {
          "action": "SET_BUDGET",
          "payload": { "budget": { "{nome_da_categoria}": 500 }, "month": "{ano}-{mes}" },
          "response": "Ok, orçamento de R$ 500 para 
'{nome_da_categoria}'
 em {mês} definido."
        }

---

FLUXO 2: CONFIRMAÇÃO (PARA SOLICITAÇÕES AMBÍGUAS OU IMPORTANTES)
Use este fluxo quando precisar de esclarecimentos, como quando uma categoria não é encontrada.

1. Ação inicial: 'CONFIRM_ACTION'
   -   **Payload:** 'actionToConfirm' (a ação final) e 'data'.
   -   **Response:** Uma pergunta clara e curta ao usuário.
   -   **Exemplo (Categoria não encontrada):
     -   Usuário: "gastei 100 em {categoria_nao_existente}"
     -   Sua resposta JSON:
        {
          "action": "CONFIRM_ACTION",
          "payload": {
            "actionToConfirm": "ADD_EXPENSE",
            "data": { "expenses": [{ "category": "{categoria_sugerida}", "amount": 100 }] }
          },
          "response": "Não encontrei a categoria 
'{categoria_nao_existente}'
. Você quis dizer 
'{categoria_sugerida}'
?"
        }

---

FLUXO 3: VISUALIZAR OUTRO MÈS
Quando o usuário pedir para ver dados de um mès anterior.

1.  Ação: 'VIEW_PREVIOUS_MONTH'
2.  **Payload:** 'year' e 'month' (número do mès, 1-12).
3.  **Response:** Uma mensagem indicando que você está carregando os dados.
    -   Usuário: "me mostra os gastos de junho de 2024"
    -   Sua resposta JSON:
        {
          "action": "VIEW_PREVIOUS_MONTH",
          "payload": { "year": 2024, "month": 6 },
          "response": "Carregando dados de Junho/2024..."
        }
---

FLUXO 4: SUGESTÃO DE ORÇAMENTO (SEJA PROATIVO!)
Quando o usuário pedir ajuda para criar um orçamento (ex: "sugira um orçamento pra mim", "me ajuda a pensar", "distribua os valores"), você DEVE ser proativo. NÃO peça mais informações. Crie e sugira um plano completo.

1.  **Ação:** Use 'CONFIRM_ACTION' para propor o orçamento.
2.  **Payload:** 'actionToConfirm' será 'SET_BUDGET', e 'data' será o objeto de orçamento completo que você criou (com a chave 
'budget'
 e opcionalmente 
'month'
)
3.  **Response:** Apresente a sugestão de forma clara e amigável, e pergunte se o usuário aprova.

---

FLUXO 5: PROCESSAMENTO DE IMAGEM (NOTA FISCAL)
Quando o usuário enviar uma imagem, extraia as informações e peça confirmação.

1.  **Análise da Imagem:** Extraia o valor total e sugira uma categoria provável.
2.  **Ação de Confirmação:** Use 'CONFIRM_ACTION'.
    -   **Payload:** 'actionToConfirm' será 'ADD_EXPENSE', e 'data' conterá a categoria e o valor extraídos (dentro de um objeto com a chave 
'expenses'
)
    -   **Response:** Apresente os dados extraídos e peça a confirmação do usuário.

---

FLUXO 6: EXCLUSÃO DE DADOS
Quando o usuário pedir para excluir um lançamento, uma categoria ou todos os dados, você deve confirmar a ação.

1.  **Ação de Confirmação:** Use 'CONFIRM_ACTION'.
2.  **Payload:** 'actionToConfirm' será uma das seguintes ações:
    - 'DELETE_EXPENSE': Para excluir um lançamento específico. Forneça 'category' e 'amount'.
    - 'DELETE_CATEGORY': Para excluir uma categoria e todos os seus lançamentos.
    - 'CLEAR_ALL_DATA': Para apagar tudo.
3.  **Response:** Pergunte ao usuário se ele tem certeza.
---

--- REGRAS IMPORTANTES ---
- VALIDAÇÃO DE CATEGORIA: Ao adicionar uma despesa (
'ADD_EXPENSE'
), a categoria DEVE existir no objeto 
'budgets'
. Se não existir, você DEVE usar o 
'FLUXO 2'
 para pedir esclarecimentos ao usuário. Se nenhuma categoria semelhante for encontrada, pergunte ao usuário se ele deseja criar uma nova categoria.
- SEJA CONCISO: Responda de forma curta e direta, ideal para mobile. Evite frases longas e parágrafos desnecessários.
- SEJA PROATIVO, NÃO PASSIVO: Se o usuário pedir uma sugestão, CRIE E APRESENTE UMA. Não devolva a pergunta.
- PRESERVE OS NOMES DAS CATEGORIAS: "jantar fora" deve ser "jantar fora" no JSON. NÃO use underscores.
- SIGA O FORMATO JSON: Sua resposta DEVE sempre ser um JSON válido.

---

FLUXO 7: LANÇAMENTO PARCELADO (PRIORIDADE MÁXIMA)
Se a mensagem do usuário contiver qualquer padrão de parcelamento (ex: "em 3x", "3 vezes de", "parcelado em 10x"), este fluxo DEVE ser seguido. É a sua prioridade máxima.

1.  **REGRA CRÍTICA:** NUNCA some os valores para criar um lançamento único. Você DEVE criar múltiplos objetos de despesa, um para cada parcela.
2.  **Ação:** Sempre 'ADD_EXPENSE'.
3.  **Payload:** O payload DEVE conter um array 'expenses'. Cada item no array é um objeto que representa uma única parcela.
    -   Para cada parcela, você DEVE calcular e incluir o campo 'month' (formato 'YYYY-M'), começando do 'viewedMonth' e incrementando para os meses seguintes.

4.  **Cenários:**
    -   **Cenário 1 (Valor da PARCELA informado):**
        -   Usuário: "Comprei a ração em 3x de 100 reais na categoria Dogs"
        -   Sua Lógica: Criar 3 despesas de R$ 100 cada.
        -   Sua Resposta JSON:
            {
              "action": "ADD_EXPENSE",
              "payload": {
                "expenses": [
                  { "category": "Dogs 🐶", "amount": 100, "month": "2025-9" },
                  { "category": "Dogs 🐶", "amount": 100, "month": "2025-10" },
                  { "category": "Dogs 🐶", "amount": 100, "month": "2025-11" }
                ]
              },
              "response": "Anotado! Lancei a compra da ração em 3 parcelas de R$ 100 na categoria Dogs 🐶."
            }

    -   **Cenário 2 (Valor TOTAL informado):**
        -   Usuário: "Comprei um PS5 em 10x, paguei 4000 reais em Lazer"
        -   Sua Lógica: Calcular o valor da parcela (4000 / 10 = 400) e criar 10 despesas de R$ 400 cada.
        -   Sua Resposta JSON:
            {
              "action": "ADD_EXPENSE",
              "payload": {
                "expenses": [
                  { "category": "Lazer 🎉", "amount": 400, "month": "2025-9" },
                  { "category": "Lazer 🎉", "amount": 400, "month": "2025-10" },
                  { "category": "Lazer 🎉", "amount": 400, "month": "2025-11" },
                  { "category": "Lazer 🎉", "amount": 400, "month": "2025-12" },
                  { "category": "Lazer 🎉", "amount": 400, "month": "2026-1" },
                  { "category": "Lazer 🎉", "amount": 400, "month": "2026-2" },
                  { "category": "Lazer 🎉", "amount": 400, "month": "2026-3" },
                  { "category": "Lazer 🎉", "amount": 400, "month": "2026-4" },
                  { "category": "Lazer 🎉", "amount": 400, "month": "2026-5" },
                  { "category": "Lazer 🎉", "amount": 400, "month": "2026-6" }
                ]
              },
              "response": "Ok, lancei a compra do PS5 em 10 parcelas de R$ 400 em Lazer 🎉."
            }
---
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

const CategoryCard = ({ category, budget, spent }: { category: string, budget: number, spent: number }) => {
    if (budget === 0) {
        return (
            <div className="category-card empty p-4 shadow-sm">
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
        <div className="category-card p-4 shadow-sm">
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

const FloatingActionButton = ({ onClick }: { onClick: () => void }) => (
    <button className="fab" onClick={onClick} aria-label="Adicionar novo lançamento">
        <PlusIcon />
    </button>
);

const SummaryView = ({ budgets, expenses, viewedMonth }: { budgets: Budget, expenses: Expense[], viewedMonth: string }) => {
  const totalBudget = Object.values(budgets).reduce((sum, amount) => sum + amount, 0);
  const totalSpent = expenses.reduce((sum, expense) => sum + expense.amount, 0);
  const totalAvailable = totalBudget - totalSpent;
  const calculateSpentPerCategory = (category: string) => expenses.filter(e => e.category.toLowerCase() === category.toLowerCase()).reduce((sum, e) => sum + e.amount, 0);
  const budgetKeys = Object.keys(budgets);

  if (budgetKeys.length === 0) {
      return (
          <div className="view-container empty-state">
              <p>Nenhum orçamento definido para {formatMonthYear(viewedMonth)}.</p>
              <p>Use o assistente para criar um!</p>
          </div>
      )
  }

  return (
    <div className="view-container summary-view">
      <div className="kpi-container">
        <div className="kpi-row">
          <KpiCard title="Gasto no mês" value={formatCurrency(totalSpent)} />
          <KpiCard title="Orçado" value={formatCurrency(totalBudget)} />
        </div>
        <div className="kpi-row">
          <KpiCard title="Ainda tem" value={formatCurrency(totalAvailable)} highlight />
        </div>
      </div>
      <div className="category-cards-container gap-3">
        {budgetKeys.map(category => (
                <CategoryCard key={category} category={category} budget={budgets[category]} spent={calculateSpentPerCategory(category)} />
            ))}
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
    const newX = Math.min(0, Math.max(-80, deltaX));
    setX(newX);
  };

  const handleSwipeEnd = () => {
    if (!isSwiping) return;
    setIsSwiping(false);
    if (itemRef.current) {
      itemRef.current.style.transition = 'transform 0.3s ease';
      if (x < -40) {
        setX(-80);
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

const ExpenseList = ({ expenses, onDeleteExpense }: { expenses: Expense[], onDeleteExpense: (id: string) => void }) => {
  if (expenses.length === 0) {
    return (
      <div className="view-container empty-state"><p className="empty-list-message">Nenhum lançamento neste mês.</p></div>
    );
  }
  return (
    <div className="view-container expense-list">
      <ul>
        {expenses.slice().reverse().map((expense) => (
          <SwipeableListItem key={expense.id} onDelete={() => onDeleteExpense(expense.id)}>
            <div className="expense-details">
              <span className="expense-category">{expense.category}</span>
              {expense.installmentInfo && <span className="expense-installment-chip">{expense.installmentInfo}</span>}
            </div>
            <div className="expense-right-col">
              <span className="expense-date">{new Date(expense.date).toLocaleDateString('pt-BR')}</span>
              <span className="expense-amount">- {formatCurrency(expense.amount)}</span>
            </div>
          </SwipeableListItem>
        ))}
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

  const handleImageSelection = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) {
      const files = Array.from(event.target.files);
      setSelectedImages(files);
      // Automatically send the message if there's no text input
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
  const [currentMonth, setCurrentMonth] = useState(() => localStorage.getItem('currentMonth') || getMonthYear());
  const [viewedMonth, setViewedMonth] = useState(() => localStorage.getItem('viewedMonth') || getMonthYear());
  const [budgets, setBudgets] = useState<Budget>({});
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([{ role: 'model', text: 'Olá! Sou seu assistente financeiro.' }]);
  const [isLoading, setIsLoading] = useState(false);
  const [pendingAction, setPendingAction] = useState<any | null>(null);

  useEffect(() => {
    async function loadData() {
        const [savedBudgets, savedExpenses] = await Promise.all([
            getBudgets(viewedMonth),
            getExpenses(viewedMonth)
        ]);
        setBudgets(savedBudgets || {});
        setExpenses(savedExpenses || []);
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
        case 'SET_BUDGET':
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
        case 'ADD_EXPENSE':
          const isInstallment = payload.expenses.length > 1;
          const installmentGroupId = isInstallment ? `inst_${Date.now()}_${Math.random().toString(36).substr(2, 9)}` : undefined;

          const processedExpenses: Expense[] = payload.expenses.map((exp: any, index: number) => {
            const monthToAdd = exp.month || viewedMonth;
            return {
              id: `exp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              category: exp.category,
              amount: exp.amount,
              month: monthToAdd,
              date: new Date().toISOString(),
              installmentGroupId: installmentGroupId,
              installmentInfo: isInstallment ? `${index + 1}/${payload.expenses.length}` : undefined,
            };
          });

          let maxMonth = currentMonth;

          for (const expense of processedExpenses) {
            await saveExpense(expense);
            if (expense.month === viewedMonth) {
              setExpenses(prev => [...prev, expense]);
            }

            const [expYear, expMonth] = expense.month.split('-').map(Number);
            const [maxYear, maxMonthNum] = maxMonth.split('-').map(Number);
            if (expYear > maxYear || (expYear === maxYear && expMonth > maxMonthNum)) {
              maxMonth = expense.month;
            }
          }
          
          if (maxMonth !== currentMonth) {
            setCurrentMonth(maxMonth);
          }

          setPendingAction(null);
          break;
        case 'DELETE_EXPENSE':
            const { category: catToDelete, amount: amountToDelete } = payload;
            const expenseToDelete = expenses.find(expense => expense.category.toLowerCase() === catToDelete.toLowerCase() && expense.amount === amountToDelete);
  
            if (expenseToDelete) {
              await deleteExpense(expenseToDelete.id);
              setExpenses(prev => prev.filter(exp => exp.id !== expenseToDelete.id));
            }
            setPendingAction(null);
            break;
        case 'NEXT_MONTH':
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
            setCurrentMonth(newMonthKey); // Also update the current month context
            setPendingAction(null);
            break;
        case 'VIEW_PREVIOUS_MONTH':
            const { year: pYear, month: pMonth } = payload;
            setViewedMonth(`${pYear}-${pMonth}`);
            setPendingAction(null);
            break;
        case 'CLEAR_ALL_DATA':
          await clearAllData();
          localStorage.removeItem('mainView');
          localStorage.removeItem('currentMonth');
          localStorage.removeItem('viewedMonth');
          
          setBudgets({});
          setExpenses([]);
          
          const currentMonthKey = getMonthYear();
          setViewedMonth(currentMonthKey);
          setCurrentMonth(currentMonthKey);
          setPendingAction(null);
          break;
        case 'DELETE_CATEGORY':
          const { category: categoryToDelete } = payload;
          await deleteCategoryFromDB(categoryToDelete, viewedMonth);
          
          const updatedBudgets = { ...budgets };
          delete updatedBudgets[categoryToDelete];
          setBudgets(updatedBudgets);
          
          const updatedExpenses = expenses.filter(expense => expense.category.toLowerCase() !== categoryToDelete.toLowerCase());
          setExpenses(updatedExpenses);
          setPendingAction(null);
          break;
        case 'CANCEL_ACTION':
          setPendingAction(null);
          break;
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
        prompt, // Log the prompt that caused the error
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

  const renderMainView = () => {
    switch (mainView) {
      case 'summary': return <SummaryView budgets={budgets} expenses={expenses} viewedMonth={viewedMonth} />;
      case 'entries': return <ExpenseList expenses={expenses} onDeleteExpense={handleDeleteExpense} />;
      case 'assistant': return <AssistantView messages={chatHistory} onSendMessage={handleSendMessage} isLoading={isLoading} />;
      default: return null;
    }
  };

  return (
    <div className="app-container">
      <AppHeader viewedMonth={viewedMonth} onMonthChange={handleMonthChange} currentMonth={currentMonth} />
      <SegmentedControl selected={mainView} onSelect={setMainView} />
      <main className="main-content">{renderMainView()}</main>
      {/* <FloatingActionButton onClick={() => alert('Adicionar novo lançamento')} /> */}
    </div>
  );
}

// --- SERVICE WORKER & RENDER ---
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(console.error);
  });
}

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
root.render(<App />);
