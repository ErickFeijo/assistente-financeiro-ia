/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { GoogleGenAI } from '@google/genai';
import { useEffect, useState, useRef } from 'react';
import ReactDOM from 'react-dom/client';

// --- TYPES ---
interface Budget {
  [category: string]: number;
}

interface Expense {
  category: string;
  amount: number;
  date: string;
}

interface ChatMessage {
  role: 'user' | 'model';
  text: string;
}

// --- AI SYSTEM INSTRUCTION ---
const SYSTEM_INSTRUCTION = `
Você é um assistente de finanças pessoais amigável, inteligente e proativo. Sua tarefa é ajudar o usuário a gerenciar orçamentos e despesas de forma conversacional.

O estado atual das finanças é fornecido em JSON, contendo os orçamentos ('budgets') e um resumo dos gastos por categoria ('expenseSummary').

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
Use este fluxo quando precisar de esclarecimentos ou para ações críticas como 'virar o mês'.

1. Ação inicial: 'CONFIRM_ACTION'
   -   **Payload:** 'actionToConfirm' (a ação final) e 'data'.
   -   **Response:** Uma pergunta clara ao usuário.
   -   **Exemplo (Adivinhação de Categoria):**
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
    -  **Exemplo (Virar o Mês):**
      - Usuário: "vamos para o próximo mês"
      - Sua resposta JSON:
        {
          "action": "CONFIRM_ACTION",
          "payload": {
            "actionToConfirm": "NEXT_MONTH",
            "data": {}
          },
          "response": "Ok! Deseja arquivar este mês e começar um novo? Posso copiar seus orçamentos atuais para o próximo mês?"
        }

2. Resposta do usuário à confirmação:
   - Se o usuário confirmar ('sim', 'pode copiar'), responda com a ação final ('ADD_EXPENSE', 'NEXT_MONTH', etc.).
     - Usuário (respondendo ao pedido de virar o mês): "sim, copia os orçamentos"
     - Sua resposta JSON:
       {
         "action": "NEXT_MONTH",
         "payload": { "copyBudgets": true },
         "response": "Tudo certo! Iniciando o novo mês com seus orçamentos copiados."
       }
   - Se o usuário negar, responda com 'CANCEL_ACTION'.

---

FLUXO 3: VISUALIZAR OUTRO MÊS
Quando o usuário pedir para ver dados de um mês anterior.

1.  Ação: 'VIEW_PREVIOUS_MONTH'
2.  **Payload:** 'year' e 'month' (número do mês, 1-12).
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
              "Moradia (Aluguel/Financiamento)": 3000,
              "Contas Fixas (Luz, Água, Internet)": 500,
              "Mercado e Farmácia": 1500,
              "Transporte": 600,
              "Saúde (Plano/Consultas)": 400,
              "Lazer e Jantar Fora": 1000,
              "Cuidados Pessoais": 500,
              "Poupança/Investimentos": 2500,
              "Emergências/Outros": 1000
            }
          },
          "response": "Com certeza! Com base no seu salário de R$ 11.000, preparei uma sugestão de orçamento detalhada para você, usando categorias específicas. Dê uma olhada:\\n\\n- **Moradia:** R$ 3.000\\n- **Contas Fixas:** R$ 500\\n- **Mercado e Farmácia:** R$ 1.500\\n- **Transporte:** R$ 600\\n- **Saúde:** R$ 400\\n- **Lazer e Jantar Fora:** R$ 1.000\\n- **Cuidados Pessoais:** R$ 500\\n- **Poupança/Investimentos:** R$ 2.500\\n- **Emergências/Outros:** R$ 1.000\\n\\nO que você acha? Posso definir este como o seu orçamento para o mês?"
        }

--- REGRAS IMPORTANTES ---
- SEJA PROATIVO, NÃO PASSIVO: Se o usuário pedir uma sugestão, CRIE E APRESENTE UMA. Não devolva a pergunta.
- PRESERVE OS NOMES DAS CATEGORIAS: "jantar fora" deve ser "jantar fora" no JSON. NÃO use underscores.
- SIGA O FORMATO JSON: Sua resposta DEVE sempre ser um JSON válido.
`;

// --- HELPER FUNCTIONS ---
const getMonthYear = (date = new Date()) => `${date.getFullYear()}-${date.getMonth() + 1}`;

const formatMonthYear = (monthKey: string) => {
    const [year, month] = monthKey.split('-');
    const date = new Date(parseInt(year), parseInt(month) - 1);
    return date.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
};

// --- AI INSTANCE ---
// Initialize the AI client once, outside the component, for efficiency.
// FIX: Switched from import.meta.env.VITE_API_KEY to process.env.API_KEY to follow Gemini API guidelines and fix TypeScript error.
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });


// --- COMPONENTS ---
const ExpenseList = ({ expenses }: { expenses: Expense[] }) => {
  const [isExpanded, setIsExpanded] = useState(false);

  if (expenses.length === 0) {
    return (
      <div className="expense-list">
        <p className="empty-list-message">Nenhum lançamento neste mês.</p>
      </div>
    );
  }

  return (
    <div className="expense-list">
      <div className="expense-list-header">
        <h3>Lançamentos do Mês</h3>
        <button onClick={() => setIsExpanded(!isExpanded)} className="toggle-expenses-btn">
          {isExpanded ? 'Ocultar' : 'Ver Tudo'}
        </button>
      </div>
      {isExpanded && (
        <ul>
          {expenses.slice().reverse().map((expense, index) => (
            <li key={index}>
              <span className="expense-category">{expense.category}</span>
              <span className="expense-date">{new Date(expense.date).toLocaleDateString('pt-BR')}</span>
              <span className="expense-amount">- R$ {expense.amount.toFixed(2)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

const BudgetDisplay = ({ budgets, expenses, viewedMonth, onMonthChange, currentMonth, isCollapsed }: { budgets: Budget; expenses: Expense[]; viewedMonth: string; onMonthChange: (direction: 'prev' | 'next') => void; currentMonth: string; isCollapsed: boolean }) => {
  const calculateSpent = (category: string) => {
    return expenses
      .filter(e => e.category.toLowerCase() === category.toLowerCase())
      .reduce((sum, e) => sum + e.amount, 0);
  };

  const getProgressColor = (percentage: number) => {
    if (percentage > 90) return 'danger';
    if (percentage > 70) return 'warning';
    return '';
  };
  
  const budgetKeys = Object.keys(budgets);
  const formattedMonth = formatMonthYear(viewedMonth);
  const isCurrentMonth = viewedMonth === currentMonth;

  return (
    <div className={`budget-display ${isCollapsed ? 'collapsed' : ''}`}>
       <div className="month-navigator">
        <button onClick={() => onMonthChange('prev')} aria-label="Mês anterior">&lt;</button>
        <h2>Orçamento de {formattedMonth.charAt(0).toUpperCase() + formattedMonth.slice(1)}</h2>
        <button onClick={() => onMonthChange('next')} disabled={isCurrentMonth} aria-label="Próximo mês">&gt;</button>
      </div>
      {budgetKeys.length === 0 && expenses.length === 0 ? (
         <div className="empty-state">
           <p>Nenhum dado para {formattedMonth}.</p>
           {viewedMonth === getMonthYear() && <p>Use o chat abaixo para começar!</p>}
        </div>
      ) : (
        <>
          <div className="budget-items-container">
            {budgetKeys.map(category => {
              const total = budgets[category];
              const spent = calculateSpent(category);
              const percentage = total > 0 ? (spent / total) * 100 : 0;
              return (
                <div key={category} className="budget-item">
                  <div className="budget-item-header">
                    <span className="category">{category}</span>
                    <span className="amount">R$ {spent.toFixed(2)} / R$ {total.toFixed(2)}</span>
                  </div>
                  <div className="progress-bar">
                    <div
                      className={`progress-bar-fill ${getProgressColor(percentage)}`}
                      style={{ width: `${Math.min(percentage, 100)}%` }}
                      aria-valuenow={percentage}
                      aria-valuemin={0}
                      aria-valuemax={100}
                    ></div>
                  </div>
                </div>
              );
            })}
          </div>
          <ExpenseList expenses={expenses} />
        </>
      )}
    </div>
  );
};

const ChatInterface = ({ messages, onSendMessage, isLoading }: { messages: ChatMessage[]; onSendMessage: (msg: string) => void; isLoading: boolean; }) => {
  const [input, setInput] = useState('');
  const chatHistoryRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (chatHistoryRef.current) {
      chatHistoryRef.current.scrollTop = chatHistoryRef.current.scrollHeight;
    }
  }, [messages, isLoading]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim() && !isLoading) {
      onSendMessage(input.trim());
      setInput('');
    }
  };

  return (
    <div className="chat-container">
      <div className="chat-history" ref={chatHistoryRef}>
        {messages.map((msg, index) => (
          <div key={index} className={`message ${msg.role}`}>
            {msg.text.split('\\n').map((line, i) => <p key={i}>{line}</p>)}
          </div>
        ))}
        {isLoading && (
          <div className="message model loading">
            <div className="dot-flashing"></div>
          </div>
        )}
      </div>
      <form onSubmit={handleSubmit} className="chat-form">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Digite seu comando..."
          aria-label="Chat input"
          disabled={isLoading}
        />
        <button type="submit" disabled={isLoading || !input.trim()}>
          Enviar
        </button>
      </form>
    </div>
  );
};

function App() {
  const [currentMonth, setCurrentMonth] = useState(getMonthYear());
  const [viewedMonth, setViewedMonth] = useState(getMonthYear());
  const [budgets, setBudgets] = useState<Budget>({});
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([
    { role: 'model', text: 'Olá! Sou seu assistente financeiro. Para começar, que tal definir seus orçamentos? Ex: "definir orçamento mercado 500, farmácia 200"' }
  ]);
  const [isLoading, setIsLoading] = useState(false);
  const [pendingAction, setPendingAction] = useState<any | null>(null);
  const [isBudgetVisible, setIsBudgetVisible] = useState(true);
  
  // Load data from localStorage when the viewed month changes
  useEffect(() => {
    const savedBudgets = localStorage.getItem(`budgets_${viewedMonth}`);
    const savedExpenses = localStorage.getItem(`expenses_${viewedMonth}`);
    setBudgets(savedBudgets ? JSON.parse(savedBudgets) : {});
    setExpenses(savedExpenses ? JSON.parse(savedExpenses) : []);
  }, [viewedMonth]);

  // Save data to localStorage when it changes for the current viewed month
  useEffect(() => {
    localStorage.setItem(`budgets_${viewedMonth}`, JSON.stringify(budgets));
  }, [budgets, viewedMonth]);

  useEffect(() => {
    localStorage.setItem(`expenses_${viewedMonth}`, JSON.stringify(expenses));
  }, [expenses, viewedMonth]);

  const handleMonthChange = (direction: 'prev' | 'next') => {
    const [year, month] = viewedMonth.split('-').map(Number);
    let newDate;
    if (direction === 'prev') {
      newDate = new Date(year, month - 2, 1); // month is 1-based, Date constructor is 0-based
    } else {
      newDate = new Date(year, month, 1);
    }
    
    const newMonthKey = getMonthYear(newDate);

    // Prevent navigating into the future
    const [currentYear, currentMonthNum] = currentMonth.split('-').map(Number);
    if (newDate.getFullYear() > currentYear || (newDate.getFullYear() === currentYear && newDate.getMonth() + 1 > currentMonthNum)) {
        return;
    }
    
    setViewedMonth(newMonthKey);
  };


  const handleSendMessage = async (userInput: string) => {
    setIsLoading(true);
    setChatHistory(prev => [...prev, { role: 'user', text: userInput }]);

    // Create a summary of expenses to reduce prompt size
    const expenseSummary = expenses.reduce((acc, expense) => {
        acc[expense.category] = (acc[expense.category] || 0) + expense.amount;
        return acc;
    }, {} as Record<string, number>);

    const currentState = {
      budgets,
      expenseSummary,
      viewedMonth,
      currentMonth,
    };

    let prompt;
    if (pendingAction) {
        prompt = `
          Contexto: O usuário está respondendo a uma pergunta de confirmação.
          Ação pendente: ${JSON.stringify(pendingAction)}
          Estado atual: ${JSON.stringify(currentState)}
          Mensagem do usuário: "${userInput}"
        `;
    } else {
        prompt = `
          Estado atual: ${JSON.stringify(currentState)}
          Mensagem do usuário: "${userInput}"
        `;
    }

    try {
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          responseMimeType: 'application/json',
        },
      });

      const aiResponseText = response.text;
      const aiResponseJson = JSON.parse(aiResponseText);
      
      const { action, payload, response: textResponse } = aiResponseJson;

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
            ...exp,
            date: new Date().toISOString(),
          }));
          setExpenses(prev => [...prev, ...newExpenses]);
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
        case 'CANCEL_ACTION':
          setPendingAction(null);
          break;
        case 'GREETING':
        case 'UNKNOWN':
        default:
          setPendingAction(null);
          break;
      }

      setChatHistory(prev => [...prev, { role: 'model', text: textResponse }]);

    } catch (error) {
      console.error("Error calling Gemini API:", error);
      const errorMessage = "Desculpe, não consegui processar sua solicitação. Tente novamente.";
      setChatHistory(prev => [...prev, { role: 'model', text: errorMessage }]);
      setPendingAction(null);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="app-container">
      <header>
        <h1>Assistente Financeiro IA</h1>
        <button onClick={() => setIsBudgetVisible(!isBudgetVisible)} className="toggle-budget-btn" aria-label="Mostrar/Ocultar resumo do orçamento">
            {isBudgetVisible ? 'Ocultar Resumo' : 'Ver Resumo'}
        </button>
      </header>
      <BudgetDisplay 
        budgets={budgets} 
        expenses={expenses} 
        viewedMonth={viewedMonth}
        onMonthChange={handleMonthChange}
        currentMonth={currentMonth}
        isCollapsed={!isBudgetVisible}
      />
      <ChatInterface
        messages={chatHistory}
        onSendMessage={handleSendMessage}
        isLoading={isLoading}
      />
    </div>
  );
}

// --- SERVICE WORKER REGISTRATION ---
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    const baseUrl = '/assistente-financeiro-ia/';
    
    // Construct the absolute URL for the Service Worker script to ensure it's loaded from the correct origin,
    // especially in sandboxed environments where root-relative paths can be misinterpreted.
    const swUrl = `${window.location.origin}${baseUrl}sw.js`;

    // By not providing a 'scope' option, we let the browser default it to the script's directory,
    // which is the correct behavior and avoids origin mismatch errors in this environment.
    navigator.serviceWorker.register(swUrl)
      .then(registration => {
        console.log('Service Worker registered successfully with scope:', registration.scope);
      })
      .catch(error => {
        console.error('Service Worker registration failed:', error);
        console.error(`Attempted to register SW at: ${swUrl}`);
      });
  });
}

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
root.render(<App />);