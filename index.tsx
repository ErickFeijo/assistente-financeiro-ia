/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { GoogleGenAI } from '@google/genai';
import { useEffect, useState, useRef } from 'react';
import ReactDOM from 'react-dom/client';

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
Quando um pedido do usuário for claro e inequívoco (ex: adicionar um gasto a uma categoria existente), execute a ação diretamente.

1.  **Ações Finais:** 'SET_BUDGET', 'ADD_EXPENSE'
2.  **Payload:** Os dados para a ação.
3.  **Response:** Uma mensagem de confirmação amigável do que você fez.
    -   Usuário: "gastei 50 no mercado"
    -   Sua resposta JSON:
        {
          "action": "ADD_EXPENSE",
          "payload": [{ "category": "mercado", "amount": 50 }],
          "response": "Anotado! Gasto de R$ 50 na categoria 'mercado' registrado."
        }
    -   Usuário: "orçamento mercado 500"
    -   Sua resposta JSON:
        {
          "action": "SET_BUDGET",
          "payload": { "mercado": 500 },
          "response": "Pronto! Orçamento de R$ 500 para 'mercado' definido."
        }

---

FLUXO 2: CONFIRMAÇÃO (PARA SOLICITAÇÕES AMBÍGUAS OU IMPORTANTES)
Use este fluxo quando precisar de esclarecimentos ou para ações críticas como 'virar o mès'.

1. Ação inicial: 'CONFIRM_ACTION'
   -   **Payload:** 'actionToConfirm' (a ação final) e 'data'.
   -   **Response:** Uma pergunta clara ao usuário.
   -   **Exemplo (Adivinhação de Categoria):
     -   Usuário: "gastei 1101 no rancho" (e a categoria 'mercado' existe)
     -   Sua resposta JSON:
        {
          "action": "CONFIRM_ACTION",
          "payload": {
            "actionToConfirm": "ADD_EXPENSE",
            "data": [{ "category": "mercado", "amount": 1101 }]
          },
          "response": "Não encontrei a categoria 'rancho'. Você quis dizer 'mercado'? Posso registrar o gasto de R$ 1101 lá?"
        }
    -  **Exemplo (Virar o Mès):
      - Usuário: "vamos para o próximo mès"
      - Sua resposta JSON:
        {
          "action": "CONFIRM_ACTION",
          "payload": {
            "actionToConfirm": "NEXT_MONTH",
            "data": {}
          },
          "response": "Ok! Deseja arquivar este mès e começar um novo? Posso copiar seus orçamentos atuais para o próximo mès?"
        }

2. Resposta do usuário à confirmação:
   - Se o usuário confirmar ('sim', 'pode copiar'), responda com a ação final ('ADD_EXPENSE', 'NEXT_MONTH', etc.).
     - Usuário (respondendo ao pedido de virar o mès): "sim, copia os orçamentos"
     - Sua resposta JSON:
       {
         "action": "NEXT_MONTH",
         "payload": { "copyBudgets": true },
         "response": "Tudo certo! Iniciando o novo mès com seus orçamentos copiados."
       }
   - Se o usuário negar, responda com 'CANCEL_ACTION'.

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
          "response": "Claro! Carregando os dados de Junho de 2024."
        }
---

FLUXO 4: SUGESTÃO DE ORÇAMENTO (SEJA PROATIVO!)
Quando o usuário pedir ajuda para criar um orçamento (ex: "sugira um orçamento pra mim", "me ajuda a pensar", "distribua os valores"), você DEVE ser proativo. NÃO peça mais informações. Crie e sugira um plano completo.

1.  **Ação:** Use 'CONFIRM_ACTION' para propor o orçamento.
2.  **Payload:** 'actionToConfirm' será 'SET_BUDGET', e 'data' será o objeto de orçamento completo que você criou.
3.  **Response:** Apresente a sugestão de forma clara e amigável, e pergunte se o usuário aprova.
    -   Usuário: "me ajuda a pensar num orçamento, ganho 11000"
    -   Sua resposta JSON:
        {
          "action": "CONFIRM_ACTION",
          "payload": {
            "actionToConfirm": "SET_BUDGET",
            "data": {
              "Hotéis 🏠": 3000,
              "Contas 💡": 500,
              "Mercado 🛒": 1500,
              "Transporte 🚗": 600,
              "Saúde 🏥": 400,
              "Lazer 🎉": 1000,
              "Cuidados Pessoais 💄": 500,
              "Investimentos 📈": 2500,
              "Emergências 🆘": 1000
            }
          },
          "response": "Com certeza! Com base no seu salário de R$ 11.000, preparei uma sugestão de orçamento detalhada para você, usando categorias específicas. Dè uma olhada:\n\n- **Hotéis 🏠:** R$ 3.000\n- **Contas 💡:** R$ 500\n- **Mercado 🛒:** R$ 1.500\n- **Transporte 🚗:** R$ 600\n- **Saúde 🏥:** R$ 400\n- **Lazer 🎉:** R$ 1.000\n- **Cuidados Pessoais 💄:** R$ 500\n- **Investimentos 📈:** R$ 2.500\n- **Emergências 🆘:** R$ 1.000\n\nO que você acha? Posso definir este como o seu orçamento para o mès?"
        }

---

FLUXO 5: PROCESSAMENTO DE IMAGEM (NOTA FISCAL)
Quando o usuário enviar uma imagem, extraia as informações e peça confirmação.

1.  **Análise da Imagem:** Extraia o valor total e sugira uma categoria provável (ex: 'Mercado', 'Restaurante', 'Transporte').
2.  **Ação de Confirmação:** Use 'CONFIRM_ACTION'.
    -   **Payload:** 'actionToConfirm' será 'ADD_EXPENSE', e 'data' conterá a categoria e o valor extraídos.
    -   **Response:** Apresente os dados extraídos e peça a confirmação do usuário.
    -   **Exemplo (Usuário envia foto de nota de supermercado):
        -   Sua resposta JSON:
            {
              "action": "CONFIRM_ACTION",
              "payload": {
                "actionToConfirm": "ADD_EXPENSE",
                "data": [{ "category": "Mercado", "amount": 185.70 }]
              },
              "response": "Analisei a nota fiscal e encontrei um total de R$ 185,70. A categoria parece ser 'Mercado'. Está correto? Posso adicionar este gasto?"
            }
3.  **Resposta do Usuário:**
    -   Se o usuário confirmar, proceda com a ação 'ADD_EXPENSE'.
    -   Se o usuário corrigir ("não, foi farmácia"), atualize a categoria e adicione o gasto.
    -   Se o usuário negar, cancele com 'CANCEL_ACTION'.

---

FLUXO 6: EXCLUSÃO DE DADOS
Quando o usuário pedir para excluir um lançamento, uma categoria ou todos os dados, você deve confirmar a ação.

1.  **Ação de Confirmação:** Use 'CONFIRM_ACTION'.
2.  **Payload:** 'actionToConfirm' será uma das seguintes ações:
    - 'DELETE_EXPENSE': Para excluir um lançamento específico. Forneça 'category' e 'amount'.
    - 'DELETE_CATEGORY': Para excluir uma categoria e todos os seus lançamentos.
    - 'CLEAR_ALL_DATA': Para apagar tudo.
3.  **Response:** Pergunte ao usuário se ele tem certeza.
    -   Exemplo (excluir lançamento):
        - Usuário: "apague o último lançamento de 50 em mercado"
        - Sua resposta JSON:
        {
          "action": "CONFIRM_ACTION",
          "payload": {
            "actionToConfirm": "DELETE_EXPENSE",
            "data": { "category": "mercado", "amount": 50 }
          },
          "response": "Tem certeza que deseja excluir o lançamento de R$ 50 em 'mercado'?"
        }
    -   Exemplo (excluir categoria):
        {
          "action": "CONFIRM_ACTION",
          "payload": {
            "actionToConfirm": "DELETE_CATEGORY",
            "data": { "category": "mercado" }
          },
          "response": "Tem certeza que deseja excluir a categoria 'mercado' e todos os seus dados? Esta ação não pode ser desfeita."
        }
    -   Exemplo (excluir tudo):
        {
          "action": "CONFIRM_ACTION",
          "payload": {
            "actionToConfirm": "CLEAR_ALL_DATA",
            "data": {}
          },
          "response": "Tem certeza que deseja excluir todos os dados? Esta ação não pode ser desfeita."
        }
4.  **Resposta do Usuário:**
    -   Se o usuário confirmar, responda com a ação final ('DELETE_EXPENSE', 'DELETE_CATEGORY', 'CLEAR_ALL_DATA').
    -   Se o usuário negar, responda com 'CANCEL_ACTION'.

--- REGRAS IMPORTANTES ---
- SEJA PROATIVO, NÃO PASSIVO: Se o usuário pedir uma sugestão, CRIE E APRESENTE UMA. Não devolva a pergunta.
- PRESERVE OS NOMES DAS CATEGORias: "jantar fora" deve ser "jantar fora" no JSON. NÃO use underscores.
- SIGA O FORMATO JSON: Sua resposta DEVE sempre ser um JSON válido.
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
  const handleSuggestionClick = (suggestion: string) => {
    setInput(suggestion);
  };

  return (
    <div className="view-container assistant-view">
        <div className="assistant-greeting"><p>Olá! Como posso ajudar hoje?</p></div>
        <div className="suggestion-chips">
            <button onClick={() => handleSuggestionClick('Definir orçamentos para o mês')}>Definir orçamentos</button>
            <button onClick={() => handleSuggestionClick('Adicionar gasto de R$50 em mercado')}>Adicionar gasto R$50</button>
            <button onClick={() => handleSuggestionClick('Quais categorias estão no vermelho?')}>Ver categorias no vermelho</button>
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
            <span className="expense-category">{expense.category}</span>
            <span className="expense-date">{new Date(expense.date).toLocaleDateString('pt-BR')}</span>
            <span className="expense-amount">- {formatCurrency(expense.amount)}</span>
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
  const [mainView, setMainView] = useState<MainView>('summary');
  const [currentMonth, setCurrentMonth] = useState(getMonthYear());
  const [viewedMonth, setViewedMonth] = useState(getMonthYear());
  const [budgets, setBudgets] = useState<Budget>({});
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([{ role: 'model', text: 'Olá! Sou seu assistente financeiro.' }]);
  const [isLoading, setIsLoading] = useState(false);
  const [pendingAction, setPendingAction] = useState<any | null>(null);

  useEffect(() => {
    const savedBudgets = localStorage.getItem(`budgets_${viewedMonth}`);
    const savedExpenses = localStorage.getItem(`expenses_${viewedMonth}`);
    setBudgets(savedBudgets ? JSON.parse(savedBudgets) : {});
    setExpenses(savedExpenses ? JSON.parse(savedExpenses) : []);
  }, [viewedMonth]);

  useEffect(() => { localStorage.setItem(`budgets_${viewedMonth}`, JSON.stringify(budgets)); }, [budgets, viewedMonth]);
  useEffect(() => { localStorage.setItem(`expenses_${viewedMonth}`, JSON.stringify(expenses)); }, [expenses, viewedMonth]);

  const handleMonthChange = (direction: 'prev' | 'next') => {
    const [year, month] = viewedMonth.split('-').map(Number);
    const newDate = new Date(year, month - (direction === 'prev' ? 2 : 0), 1);
    const newMonthKey = getMonthYear(newDate);
    const [currentYear, currentMonthNum] = currentMonth.split('-').map(Number);
    if (newDate.getFullYear() > currentYear || (newDate.getFullYear() === currentYear && newDate.getMonth() + 1 > currentMonthNum)) return;
    setViewedMonth(newMonthKey);
  };

  const handleDeleteExpense = (expenseId: string) => {
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

      let finalHistory = [...newChatHistory, { role: 'model', text: textResponse }];

      switch (action) {
        case 'CONFIRM_ACTION':
          setPendingAction(payload);
          break;
        case 'SET_BUDGET':
          setBudgets(prev => ({ ...prev, ...payload }));
          setPendingAction(null);
          break;
        case 'ADD_EXPENSE':
          const newExpenses: Expense[] = payload.map((exp: { category: string, amount: number }) => ({
            id: `exp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            ...exp,
            date: new Date().toISOString(),
          }));
          setExpenses(prev => [...prev, ...newExpenses]);
          setPendingAction(null);
          break;
        case 'DELETE_EXPENSE':
            const { category: catToDelete, amount: amountToDelete } = payload;
            const expenseIndex = expenses.reduce((lastIndex, expense, currentIndex) => {
                if (expense.category.toLowerCase() === catToDelete.toLowerCase() && expense.amount === amountToDelete) {
                    return currentIndex;
                }
                return lastIndex;
            }, -1);
  
            if (expenseIndex > -1) {
              const updatedExpenses = [...expenses];
              updatedExpenses.splice(expenseIndex, 1);
              setExpenses(updatedExpenses);
            }
            setPendingAction(null);
            break;
        case 'NEXT_MONTH':
            const [year, month] = viewedMonth.split('-').map(Number);
            const nextDate = new Date(year, month, 1);
            const newMonthKey = `${nextDate.getFullYear()}-${nextDate.getMonth() + 1}`;
            
            if (payload.copyBudgets) {
              const currentBudgets = localStorage.getItem(`budgets_${viewedMonth}`);
              if(currentBudgets) {
                  localStorage.setItem(`budgets_${newMonthKey}`, currentBudgets);
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
          const keysToRemove = [];
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && (key.startsWith('budgets_') || key.startsWith('expenses_'))) {
              keysToRemove.push(key);
            }
          }
          keysToRemove.forEach(key => localStorage.removeItem(key));
          
          setBudgets({});
          setExpenses([]);
          
          const currentMonthKey = getMonthYear();
          setViewedMonth(currentMonthKey);
          setCurrentMonth(currentMonthKey);
          setPendingAction(null);
          break;
        case 'DELETE_CATEGORY':
          const { category: categoryToDelete } = payload;
          
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
